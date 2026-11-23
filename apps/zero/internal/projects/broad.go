package projects

import (
	"os"
	"path/filepath"
)

// BroadScanDepth is how deep discovery looks below a broad root unless the
// user set the scan depth (decision 0194).
const BroadScanDepth = 1

// broadFolders are the folders too broad to scan by default, besides the
// user's home and its Library (decision 0194).
var broadFolders = []string{
	"/", "/home", "/Users", "/root", "/Volumes", "/mnt", "/media", "/run/media",
	"/usr", "/opt", "/var", "/etc", "/System", "/Library", "/Applications",
}

// Broad reports whether dir is a folder too broad to scan by default: the
// filesystem root, the user's home, and the like (decision 0194). Only the
// folders themselves are broad, never their descendants; both sides are
// compared with symlinks evaluated.
func Broad(dir string) bool {
	home, err := os.UserHomeDir()
	if err != nil {
		home = ""
	}
	return broad(dir, home)
}

// broad is Broad with home as the user's home; "" has none.
func broad(dir, home string) bool {
	absolute, err := filepath.Abs(dir)
	if err != nil {
		return false
	}
	target := canonical(absolute)
	candidates := broadFolders
	if home != "" {
		candidates = append(candidates[:len(candidates):len(candidates)], home, filepath.Join(home, "Library"))
	}
	for _, candidate := range candidates {
		if canonical(candidate) == target {
			return true
		}
	}
	return false
}

// BroadDepth is the discovery depth below a broad root: scanDepth when the
// user set it, else BroadScanDepth.
func BroadDepth(scanDepth int, explicit bool) int {
	if explicit {
		return scanDepth
	}
	return BroadScanDepth
}
