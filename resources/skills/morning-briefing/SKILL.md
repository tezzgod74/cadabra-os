---
name: morning-briefing
description: Use when the user asks for their morning briefing, a quick start-of-day summary, or "what's my day look like". Gives the weather, today's new email and a few top headlines.
examples:
  - morning briefing
  - give me my morning briefing
  - what does my day look like
  - start my day
voice: Speak it as three or four short sentences, no lists.
requires: [get_weather, search_email]
---

# Morning briefing

1. Get today's weather for the user's location with get_weather (day "today").
2. Check today's email with search_email (since "today"). Mention how many new
   emails there are and who the most important-looking ones are from. Don't read
   whole emails unless the user asks.
3. If web access is available, find three top news headlines for today. If it
   isn't, skip this step and say so in a few words.
4. Finish with one friendly sentence. Don't ask "anything else?".

Keep the whole briefing short. If email isn't connected, say so once and carry on.
