package main

import (
	"flag"
	"net/http"
)

func main() {
	listen := flag.String("listen", ":8090", "listen address")
	flag.String("db-host", "localhost", "database host")
	flag.Parse()

	http.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("ok"))
	})
	http.HandleFunc("/api/metrics", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("[]"))
	})
	http.ListenAndServe(*listen, nil)
}
