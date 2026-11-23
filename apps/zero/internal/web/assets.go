package web

import (
	"embed"
	"io/fs"
	"net/http"
	"path"
)

//go:embed dist vendor/PX0-LICENSE.txt
var assets embed.FS

var noticeAssets = map[string]string{
	"/assets/vendor/PX0-LICENSE.txt": "vendor/PX0-LICENSE.txt",
}

func (a *App) serveAsset(w http.ResponseWriter, name string) {
	content, err := fs.ReadFile(assets, name)
	if err != nil {
		http.NotFound(w, nil)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = w.Write(content)
}

func (a *App) serveFrontendAsset(w http.ResponseWriter, name string) {
	if !fs.ValidPath(name) {
		http.NotFound(w, nil)
		return
	}
	content, err := fs.ReadFile(assets, "dist/"+name)
	if err != nil {
		http.NotFound(w, nil)
		return
	}
	switch path.Ext(name) {
	case ".css":
		w.Header().Set("Content-Type", "text/css; charset=utf-8")
	case ".js":
		w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
	case ".woff2":
		w.Header().Set("Content-Type", "font/woff2")
	case ".wasm":
		w.Header().Set("Content-Type", "application/wasm")
	default:
		w.Header().Set("Content-Type", "application/octet-stream")
	}
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = w.Write(content)
}

// serveShell writes the app shell; pages read their data from the API.
func (a *App) serveShell(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(a.shell))
}
