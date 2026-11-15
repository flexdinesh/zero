package main

import (
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// The app is a client of zero (decision 0094): from the zero module it
// imports only the transport contract, the connection model, the Go client,
// and the log files it shares with the daemon (decision 0152). Its module path sits under zero's, so Go's internal rule would not
// stop it.
func TestImportsOnlyZeroContractAndClient(t *testing.T) {
	const zero = "github.com/flexdinesh/zero/"
	allowed := map[string]bool{zero + "pkg/contract": true, zero + "pkg/connection": true, zero + "pkg/client": true, zero + "pkg/logfile": true}
	files := 0
	err := filepath.WalkDir(".", func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() && (path == "build" || path == "resources") {
			return filepath.SkipDir
		}
		if entry.IsDir() || !strings.HasSuffix(path, ".go") {
			return nil
		}
		file, err := parser.ParseFile(token.NewFileSet(), path, nil, parser.ImportsOnly)
		if err != nil {
			return err
		}
		files++
		for _, spec := range file.Imports {
			imported, err := strconv.Unquote(spec.Path.Value)
			if err != nil {
				return err
			}
			if strings.HasPrefix(imported, zero) && !strings.HasPrefix(imported, zero+"apps/desktop/") && !allowed[imported] {
				t.Errorf("%s imports %s; the app imports only pkg/contract, pkg/connection, pkg/client, and pkg/logfile from zero", path, imported)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if files == 0 {
		t.Fatal("no Go files found")
	}
}
