---
# ---------------------------------------------------------------------------
# This is a Cadabra skill template. Copy this whole folder, rename the copy,
# and edit this file in Notepad. (Or use Settings > Skills > "New skill from
# template", which does the copying for you.)
#
# Lines that start with # are notes for you. Cadabra ignores them.
# The part between the two "---" lines is the skill's "label". The part after
# the second "---" is what you want Cadabra to do, in plain English.
# ---------------------------------------------------------------------------

# name: a short name for the skill. Lowercase letters, numbers and dashes only.
# Example: name: plan-my-trip
name: my-new-skill

# description: one or two sentences saying WHEN Cadabra should use this skill.
# This is the part Cadabra's AI reads to decide, so be specific.
# Example: description: Use when I ask to plan a weekend trip. Checks the
#          weather and opens my usual travel sites.
description: Use when I ask for my new skill. Replace this sentence with when the skill should be used.

# examples: things you might say to start this skill (optional, up to 20).
# When you say one of these (or something very close), Cadabra loads the
# skill straight away. Keep them short and natural.
examples:
  - run my new skill
  - do my new skill

# voice: how spoken answers should sound for this skill (optional).
# Example: voice: Keep it to two short sentences.
voice: Keep spoken answers short.

# requires: Cadabra tools this skill expects (optional, just a reminder).
# Some you can use: get_weather, search_email, read_email, open_url,
# launch_app, find_apps, run_in_terminal, type_text, see_screen.
requires: []
---

# My new skill

Write the steps you want, one per line, as if you were asking a helpful friend.
For example:

1. Check today's weather where I live.
2. Tell me if I have any new emails from my boss.
3. Open my calendar website.
4. Finish with one short sentence summing it up.

Tips:
- Say what "done" looks like ("finish by telling me…").
- Name the apps and websites you use ("open Outlook", "go to bbc.co.uk").
- You can put extra reference text (a list of sites, a checklist) in a .txt or
  .md file next to this one; Cadabra can read it with the skill.
- A skill can't switch off Cadabra's safety checks. Anything risky still asks
  you first, and nothing in a skill folder is ever run as a program.
