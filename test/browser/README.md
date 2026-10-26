# Workbench browser regression

`workbench-races.js` is a Playwright CLI `run-code` function. It uses a separate browser context and intercepts every API request. The local workbench currently open in the CLI browser session (including an automatically selected port) supplies only static HTML/CSS/JS; the test does not connect to personal SSH servers or edit real files.

With the workbench and a Playwright CLI browser session open, run from the repository root:

```sh
playwright-cli run-code "$(cat test/browser/workbench-races.js)"
```

Use the configured Playwright CLI wrapper if the command is not installed globally. A successful result lists eight checks: server and terminal-tab focus during automatic refresh, terminal switch, server switch, output/input reset after a same-name worker restart, delayed file read, and delayed backup restore. This browser check runs separately from `npm test`.
