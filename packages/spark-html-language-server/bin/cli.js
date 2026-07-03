#!/usr/bin/env node
// spark-html-language-server — LSP over stdio. Editors launch this binary;
// see the package README for VS Code setup.
import { connectStdio } from '../src/server.js';
connectStdio();
