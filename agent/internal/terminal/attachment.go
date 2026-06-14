package terminal

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"sync"
	"time"

	"github.com/creack/pty"
)

type Attachment struct {
	file   *os.File
	cmd    *exec.Cmd
	done   chan struct{}
	writeM sync.Mutex
	closeM sync.Mutex
	closed bool
}

var ErrClosed = errors.New("terminal attachment closed")

func Attach(ctx context.Context, socketPath string, session string, cols int, rows int, onOutput func([]byte), onClose func(error)) (*Attachment, error) {
	if cols <= 0 {
		cols = 120
	}
	if rows <= 0 {
		rows = 40
	}

	cmd := exec.CommandContext(ctx, "tmux", "-S", socketPath, "attach-session", "-t", session)
	cmd.Env = append(os.Environ(), "TERM="+attachTERM())
	file, err := pty.StartWithSize(cmd, &pty.Winsize{
		Rows: uint16(rows),
		Cols: uint16(cols),
	})
	if err != nil {
		return nil, err
	}

	attachment := &Attachment{
		file: file,
		cmd:  cmd,
		done: make(chan struct{}),
	}
	ready := make(chan struct{})
	exited := make(chan error, 1)
	var earlyOutput []byte
	var earlyOutputM sync.Mutex
	var readyOnce sync.Once
	signalReady := func() {
		readyOnce.Do(func() {
			close(ready)
		})
	}

	go func() {
		defer close(attachment.done)
		defer func() {
			signalReady()
			_ = file.Close()
		}()

		buf := make([]byte, 32*1024)
		for {
			n, err := file.Read(buf)
			if n > 0 {
				chunk := make([]byte, n)
				copy(chunk, buf[:n])
				earlyOutputM.Lock()
				if len(earlyOutput) < 4096 {
					earlyOutput = append(earlyOutput, chunk...)
					if len(earlyOutput) > 4096 {
						earlyOutput = earlyOutput[:4096]
					}
				}
				earlyOutputM.Unlock()
				signalReady()
				onOutput(chunk)
			}
			if err != nil {
				waitErr := cmd.Wait()
				alreadyClosed := attachment.markClosed()
				exited <- waitErr
				if !alreadyClosed && onClose != nil {
					onClose(attachExitError(waitErr, earlyOutput))
				}
				return
			}
		}
	}()

	select {
	case <-ready:
		select {
		case err := <-exited:
			return nil, attachExitError(err, earlyOutput)
		case <-time.After(50 * time.Millisecond):
		}
	case err := <-exited:
		return nil, attachExitError(err, earlyOutput)
	case <-ctx.Done():
		_ = attachment.Close()
		return nil, ctx.Err()
	case <-time.After(2 * time.Second):
	}

	return attachment, nil
}

func (a *Attachment) Write(data string) error {
	a.writeM.Lock()
	defer a.writeM.Unlock()

	if a.isClosed() {
		return ErrClosed
	}
	_, err := a.file.WriteString(data)
	return err
}

func (a *Attachment) Resize(cols int, rows int) error {
	if cols <= 0 || rows <= 0 {
		return nil
	}
	if a.isClosed() {
		return ErrClosed
	}
	return pty.Setsize(a.file, &pty.Winsize{
		Rows: uint16(rows),
		Cols: uint16(cols),
	})
}

func (a *Attachment) Close() error {
	alreadyClosed := a.markClosed()

	var err error
	if !alreadyClosed {
		err = a.file.Close()
	}
	<-a.done
	return err
}

func (a *Attachment) Closed() bool {
	return a.isClosed()
}

func (a *Attachment) Done() <-chan struct{} {
	return a.done
}

func (a *Attachment) isClosed() bool {
	a.closeM.Lock()
	defer a.closeM.Unlock()
	return a.closed
}

func (a *Attachment) markClosed() bool {
	a.closeM.Lock()
	defer a.closeM.Unlock()
	alreadyClosed := a.closed
	a.closed = true
	return alreadyClosed
}

func attachExitError(err error, output []byte) error {
	message := string(output)
	if message != "" {
		return fmt.Errorf("%w: %s", errOrClosed(err), message)
	}
	return errOrClosed(err)
}

func errOrClosed(err error) error {
	if err != nil {
		return err
	}
	return errors.New("terminal attach closed")
}

func attachTERM() string {
	for _, term := range []string{"xterm-256color", "screen-256color", "xterm", "vt100"} {
		if exec.Command("infocmp", term).Run() == nil {
			return term
		}
	}
	return "vt100"
}
