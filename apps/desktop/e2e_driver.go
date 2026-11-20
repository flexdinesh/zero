//go:build e2e

package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"log"
	"net"
	"os"
	"time"

	"github.com/egoist/mygo"

	"github.com/flexdinesh/zero/apps/desktop/internal/proxy"
	"github.com/flexdinesh/zero/apps/desktop/internal/review"
)

// mygo's automation plugin evaluates scripts in page windows only. A window
// of native UI (decision 0184) holds the app's page in a web view, which the
// plugin cannot reach, so end-to-end builds serve this driver on the Unix
// socket ZERO_E2E_DRIVER names: one JSON request per line, answered in
// order, in the plugin's own shapes. Release builds never carry it.
//
//	{"id": 1, "method": "eval", "params": {"host": "local", "script": "return 1"}}
//	{"id": 1, "result": {"value": 1}}
//
// Methods: windows lists the connection windows ({host, shell, url}); eval
// runs a script as the body of an async function in a window's page of the
// app; capture answers that page as a PNG; shown answers the guest the
// window shows and where. host defaults to the local connection; project
// targets that project's guest, composer the window's composer.
func startE2EDriver(h *host) {
	path := os.Getenv("ZERO_E2E_DRIVER")
	if path == "" {
		return
	}
	_ = os.Remove(path)
	listener, err := net.Listen("unix", path)
	if err != nil {
		log.Printf("zero-app: e2e driver: %v", err)
		return
	}
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go serveE2E(h, conn)
		}
	}()
}

type e2eRequest struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Params struct {
		Host   string `json:"host"`
		Script string `json:"script"`
		// Project names a guest of the window: eval and capture then act
		// on its page, not the app's.
		Project string `json:"project"`
		// Composer targets the window's composer instead.
		Composer bool `json:"composer"`
	} `json:"params"`
}

type e2eError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type e2eResponse struct {
	ID     json.RawMessage `json:"id"`
	Result any             `json:"result,omitempty"`
	Error  *e2eError       `json:"error,omitempty"`
}

func serveE2E(h *host, conn net.Conn) {
	defer func() { _ = conn.Close() }()
	reader := bufio.NewReaderSize(conn, 1<<20)
	encoder := json.NewEncoder(conn)
	for {
		line, err := reader.ReadBytes('\n')
		if err != nil {
			return
		}
		var request e2eRequest
		response := e2eResponse{}
		if err := json.Unmarshal(line, &request); err != nil {
			response.Error = &e2eError{Code: "invalid", Message: err.Error()}
		} else {
			response.ID = request.ID
			result, err := h.e2eCall(request)
			if err != nil {
				response.Error = &e2eError{Code: "failed", Message: err.Error()}
			} else {
				response.Result = result
			}
		}
		if err := encoder.Encode(response); err != nil {
			return
		}
	}
}

type e2eWindow struct {
	Host  string `json:"host"`
	Shell bool   `json:"shell"`
	URL   string `json:"url"`
}

func (h *host) e2eCall(request e2eRequest) (any, error) {
	if request.Method == "windows" {
		h.mu.Lock()
		open := make(map[string]*mygo.Window, len(h.windows))
		for connectionHost, window := range h.windows {
			open[connectionHost] = window
		}
		h.mu.Unlock()
		listing := []e2eWindow{}
		for connectionHost, window := range open {
			listing = append(listing, e2eWindow{Host: connectionHost, Shell: h.shellOf(window) != nil, URL: h.page(window).URL()})
		}
		return map[string]any{"windows": listing}, nil
	}
	connectionHost := request.Params.Host
	if connectionHost == "" {
		connectionHost = proxy.Host
	}
	h.mu.Lock()
	window := h.windows[connectionHost]
	h.mu.Unlock()
	if window == nil {
		return nil, errors.New("no window on " + connectionHost)
	}
	var visitor *guest
	if request.Params.Project != "" {
		if frame := h.shellOf(window); frame != nil {
			visitor = frame.guest(request.Params.Project)
		}
		if visitor == nil {
			return nil, errors.New("no guest for " + request.Params.Project)
		}
	}
	var composer *mygo.WebView
	if request.Params.Composer {
		if frame := h.shellOf(window); frame != nil {
			composer = frame.composerView()
		}
		if composer == nil {
			return nil, errors.New("no composer")
		}
	}
	switch request.Method {
	case "shown":
		// The guest the window shows, and where, in its layout units.
		frame := h.shellOf(window)
		if frame == nil {
			return nil, errors.New("not a window of native UI")
		}
		frame.mu.Lock()
		defer frame.mu.Unlock()
		shown := map[string]any{"project": frame.shown, "x": frame.at.X, "y": frame.at.Y, "width": frame.at.Width, "height": frame.at.Height, "guests": len(frame.guests), "composer": nil}
		if composing := frame.composing; composing != nil && frame.guests[frame.shown] == composing.guest {
			at := review.PlaceComposer(composing.capture.Rect, composing.guestZoom, frame.at, composing.height, frame.layout.zoom, frame.layout.width, frame.layout.height)
			shown["composer"] = map[string]any{"x": at.X, "y": at.Y, "width": at.Width, "height": at.Height}
		}
		return shown, nil
	case "eval":
		ctx, cancel := context.WithTimeout(context.Background(), 7*time.Second)
		defer cancel()
		page := h.page(window)
		if visitor != nil {
			page = visitor.view.Page()
		}
		if composer != nil {
			page = composer.Page()
		}
		value, err := page.EvalContext(ctx, request.Params.Script)
		if err != nil {
			return nil, err
		}
		return map[string]any{"value": value}, nil
	case "capture":
		var (
			data []byte
			err  error
		)
		if composer != nil {
			data, err = composer.CapturePage()
		} else if visitor != nil {
			data, err = visitor.view.CapturePage()
		} else if frame := h.shellOf(window); frame != nil {
			data, err = frame.zeroView().CapturePage()
		} else {
			data, err = window.CapturePage()
		}
		if err != nil {
			return nil, err
		}
		return map[string]any{"png": data}, nil
	}
	return nil, errors.New("no method " + request.Method)
}
