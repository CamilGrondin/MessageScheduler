# MessageScheduler

Schedule messages to send later using the Discord attachment menu (BetterDiscord plugin).

Author: camilgrondin - https://github.com/CamilGrondin
Repository: https://github.com/CamilGrondin/MessageScheduler

Features
- Schedule one or more messages.
- Use minutes or a local time (HH:MM).
- Edit or cancel scheduled items.
- Countdown display for pending messages.
- Stores schedules locally.

Usage
1) Open the attachment menu (plus button).
2) Click "Schedule a message".
3) Enter message blocks separated with ---.
4) Enter timing like 15 or 20:30.
5) Click Schedule.

Notes and limitations
- Discord must be open and the plugin enabled for timers to fire.
- If a scheduled time passes while Discord is closed, the message is sent shortly after startup.
- Messages are sent with your current account permissions.

Data and privacy
- Schedules are stored locally in BetterDiscord data under the key "scheduled-messages".
- This plugin does not make network requests.

Installation
- Drop `MessageScheduler.plugin.js` into your BetterDiscord plugins folder and enable the plugin.

Uninstall
- Remove the plugin file.
- To clear pending items, open the plugin and cancel them.