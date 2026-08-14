package main

import (
	"encoding/json"
	"fmt"
	"os"
)

type response struct {
	Message string `json:"message,omitempty"`
	Error   string `json:"error,omitempty"`
}

func main() {
	if len(os.Args) != 3 || os.Args[1] != "greet" || os.Args[2] == "" || len(os.Args[2]) > 32 {
		_ = json.NewEncoder(os.Stderr).Encode(response{Error: "usage: hyperfixture greet <name>"})
		os.Exit(2)
	}
	if err := json.NewEncoder(os.Stdout).Encode(response{Message: fmt.Sprintf("hello, %s", os.Args[2])}); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
