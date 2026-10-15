---
name: quick-note
description: Use when the user asks to jot down, save or remember a quick note (for example "make a note to call the dentist"). Saves it as a text file in Documents with the date and time.
examples:
  - take a quick note
  - make a note
  - jot this down
voice: Confirm in one short sentence, including the file name.
requires: [run_in_terminal]
---

# Quick note

1. Work out the note's text from what the user said. If they didn't say what
   the note should say, ask once.
2. Save it with run_in_terminal as a new text file in the user's Documents
   folder, named "Note YYYY-MM-DD HHMM.txt" with today's date and time, and the
   date and time as the first line of the note. Use one simple PowerShell
   command (Set-Content). Cadabra will show the user the exact command first.
3. Say where the note was saved, in one sentence.

Never overwrite an existing file: if the name is taken, add " (2)".
