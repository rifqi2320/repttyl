package terminal

import (
	"context"
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
}

func Attach(ctx context.Context, socketPath string, session string, cols int, rows int, onOutput func([]byte)) (*Attachment, error) {
	if cols <= 0 {
		cols = 120
	}
	if rows <= 0 {
		rows = 40
	}

	cmd := exec.CommandContext(ctx, "tmux", "-S", socketPath, "attach-session", "-t", session)
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
				signalReady()
				onOutput(chunk)
			}
			if err != nil {
				_ = cmd.Wait()
				return
			}
		}
	}()

	select {
	case <-ready:
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

	_, err := a.file.WriteString(data)
	return err
}

func (a *Attachment) Resize(cols int, rows int) error {
	if cols <= 0 || rows <= 0 {
		return nil
	}
	return pty.Setsize(a.file, &pty.Winsize{
		Rows: uint16(rows),
		Cols: uint16(cols),
	})
}

func (a *Attachment) Close() error {
	err := a.file.Close()
	<-a.done
	return err
}
