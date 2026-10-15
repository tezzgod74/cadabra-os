---
name: work-setup
description: Use when the user wants to start work or "set up for work". Opens their usual work apps and websites from the list in sites.txt.
examples:
  - set up for work
  - start my work setup
  - get me ready for work
voice: Say only what you opened, in one sentence.
requires: [launch_app, open_url]
---

# Work setup

Open everything listed in sites.txt (in this skill's folder), in order:

- Lines that start with "app:" are apps: open them with launch_app.
- Lines that start with "site:" are web pages: open them with open_url.
- Skip anything that's already open.

If an app isn't installed, say which one and carry on with the rest.
When you're done, say what you opened in one sentence.

(Edit sites.txt to make this your own. It's a copy of the example: put it in
your own skills folder so updates don't replace your changes.)
