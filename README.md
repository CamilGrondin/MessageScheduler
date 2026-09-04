# MessageScheduler

MessageScheduler is a BetterDiscord plugin that adds a local interface for preparing messages to send later from Discord's attachment menu.

Repository: <https://github.com/CamilGrondin/MessageScheduler>

## Features

- Prepare one or more messages for a later send time.
- Choose a delay in minutes or a local time in `HH:MM` format.
- Edit or cancel pending schedules.
- Show a countdown for pending schedules.
- Keep schedules and unscheduled drafts on the local device.

## Usage

1. Open Discord's attachment menu using the plus button.
2. Select **Schedule a message**.
3. Enter one or more message blocks, separated by `---`.
4. Enter a delay such as `15`, or a local time such as `20:30`.
5. Review the destination and send time, then select **Schedule**.

## Limitations and safety

- Discord must remain open and the plugin must remain enabled for its timers to run.
- If a scheduled time passes while Discord is closed, the plugin attempts to send the message after startup.
- Sending uses the current account and its existing channel permissions.
- Do not use the plugin to send unsolicited, repetitive, or bulk messages.
- Test changes only with accounts and channels you control.

## Data and privacy

- Schedules are stored locally by BetterDiscord under the `scheduled-messages` key.
- Unscheduled drafts are stored locally by BetterDiscord under the `message-drafts` key.
- The plugin does not make network requests of its own.

## Installation

1. Copy `MessageScheduler.plugin.js` to the BetterDiscord plugins folder.
2. Enable **MessageScheduler** in BetterDiscord.

## Removal

1. Cancel pending schedules in the plugin if they are no longer wanted.
2. Disable and remove `MessageScheduler.plugin.js` from the BetterDiscord plugins folder.
