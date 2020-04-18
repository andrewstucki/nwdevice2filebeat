//  Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
//  or more contributor license agreements. Licensed under the Elastic License;
//  you may not use this file except in compliance with the Elastic License.

package cmd

import (
	"io/ioutil"
	"log"
	"os"

	"github.com/spf13/cobra"

	"github.com/adriansr/nwdevice2filebeat/generator/javascript"
	"github.com/adriansr/nwdevice2filebeat/model"
	"github.com/adriansr/nwdevice2filebeat/parser"
)

var generateCmd = &cobra.Command{
	Use:   "generate",
	Short: "Generate a new Filebeat fileset from a NetWitness device",
	Run: func(cmd *cobra.Command, args []string) {
		devicePath, err := cmd.PersistentFlags().GetString("device")
		if err != nil {
			log.Panic(err)
		}
		dev, err := model.NewDevice(devicePath)
		if err != nil {
			LogError("Failed to load device", "path", devicePath, "reason", err)
			return
		}
		log.Printf("Loaded XML %s", dev.String())
		p, err := parser.New(dev)
		if err != nil {
			LogError("Failed to parse device", "path", devicePath, "reason", err)
			//return
		}
		numBytes, err := javascript.Generate(p, ioutil.Discard)
		if err != nil {
			LogError("Failed to generate javascript pipeline", "reason", err)
		}
		var size int64
		if st, err := os.Stat(dev.XMLPath); err == nil {
			size = st.Size()
		}
		log.Printf("XXX %d bytes for pipeline %s (%s) from %d original (%.2f%%)\n",
			numBytes, dev.Description.DisplayName, dev.Description.Name,
			size, 100.0*float64(numBytes) / float64(size))
	},
}

func init() {
	generateCmd.PersistentFlags().String("device", "", "Input device path")
	generateCmd.MarkPersistentFlagRequired("device")
}
