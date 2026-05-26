# Knomo

English | [简体中文](./README.zh-CN.md)

> A lightweight Memos entry for Obsidian: quick capture, daily context, monthly collection, and local-first control.

Knomo is a local memo-first capture plugin built for Obsidian. It creates a smoother workflow for capturing fragmented thoughts inside your Vault:

- Each memo is automatically written to the Daily Note of the day;
- At the same time, Knomo automatically creates or updates monthly Memos Markdown files;
- Daily Notes preserve the context of each day, while monthly Memos files provide a centralized view for review;
- Memo content, Markdown files, and necessary related data are all stored locally in your Vault.

This allows you to capture thoughts as quickly as posting a memo, without moving your content away from Obsidian’s Daily Notes, tags, backlinks, and Markdown system.

Knomo does not try to replace Obsidian’s files, folders, tags, backlinks, or Daily Notes. It also does not automatically organize or rewrite your Markdown content. It simply provides a lighter and smoother capture entry, letting each memo enter your local Obsidian Markdown workflow while preserving the original content.

---

## Name Origin

**Knomo** is a combination of **Knowledge** and **Memo**.

It represents the connection between knowledge, ideas, and everyday flashes of thought: fragments that have not yet become long-form notes, projects, or structured systems can first be captured as memos, then gradually settle, connect, and become reusable inside your local Obsidian knowledge base.

---

## Screenshots

### Desktop

![](./screenshots/screenshot-main.png)

![](./screenshots/screenshot-sidebar.png)

![](./screenshots/screenshot-settingstab.png)


### Mobile

![](./screenshots/screenshot-mobile-collage.png)

![](./screenshots/screenshot-mobile-collage2.png)



---

## Why Knomo?

Obsidian is great for long-term knowledge management, but many ideas, excerpts, work reminders, and temporary thoughts are not suitable for complex structures from the very beginning.

Knomo lets these pieces of content be captured quickly as memos, then automatically enter your local Obsidian Markdown workflow.

It mainly solves the following problems:

### 1. Faster capture

You do not need to open a file, find a heading, or decide where the content should go first. Open Knomo, write the memo, and save it.

### 2. Daily context is preserved

Each memo is automatically written to the Daily Note of the day, preserving the real context of when it happened. When you review your day in the evening, you do not need to search for fragmented notes in another tool.

### 3. Automatic monthly collection

Knomo automatically creates or updates monthly Memos Markdown files.

Daily Notes answer “what happened today,” while monthly Memos files answer “what did I write down this month.”

### 4. Non-destructive to your existing Daily Notes

Knomo tries to write memos into a specified area, without forcibly reorganizing your Daily Note or turning it into a plugin-specific format.

### 5. Smoother on mobile

Many fragmented thoughts happen on your phone. Knomo includes many interaction improvements for Obsidian mobile, including input, keyboard adaptation, touch-friendly buttons, card browsing, search entry, and sidebar experience.

### 6. Content stays in your local Vault

Memo content, monthly collection files, and necessary related data are all stored in your local Vault, making them easy to back up, sync, migrate, and preserve long-term.

---

## Core Principles

### Memo-first

Knomo treats the memo as the primary entry point. You first capture ideas, then use tags, search, Daily Notes, monthly collections, and reviews to view, locate, and reuse those pieces of content.

### Daily Note + Monthly Memos

Knomo’s core workflow consists of two parts:

- **Daily Note**: records memos created on that day and preserves daily context;
- **Monthly Memos Markdown file**: automatically collects memos by month for centralized browsing and long-term review.

Both files are stored in your Vault and can be read, edited, backed up, and migrated directly. Knomo tries to preserve the original Markdown content and does not actively perform additional organization, classification, or rewriting.

### Obsidian Markdown-friendly

Knomo tries to support and preserve common Obsidian Markdown syntax, such as tags, internal links, image embeds, lists, quotes, and regular Markdown text.

The content you write in a memo remains Markdown that Obsidian can understand, rather than a private format that only belongs to Knomo.

### Local-first

Your memo content, Markdown files, and necessary related data are stored locally in your Vault. Knomo does not rely on external servers, does not require account registration, and does not actively upload your notes.

### Non-destructive

Knomo tries not to break your existing Daily Note structure and does not forcibly turn your Daily Notes into a plugin-specific database.

### Mobile-friendly

Knomo does not treat mobile as a smaller version of desktop. Instead, it optimizes input, browsing, search, and touch interactions around real mobile capture scenarios.

### Low friction

Knomo tries to reduce confirmation dialogs, complex settings, and interruptive operations, keeping the capture process lightweight.

---

## Key Features

### Quick capture

Write and save directly inside the Knomo view, without opening a specific Markdown file first.

Suitable for capturing:

- Fragmented thoughts;
- Reading excerpts;
- Work reminders;
- Project ideas;
- Daily review materials;
- Temporary content to process later.

---

### Write to Daily Note

Knomo depends on Obsidian’s core Daily Notes plugin.

New memos can be automatically written under a specified heading in the Daily Note of the day, for example:

```md
## Memos

- 18:30:12 I came up with a new product idea today #idea
- 21:10:03 I found a great point while reading #reading
```

This means your fragmented notes will not be scattered in another tool, but will naturally enter the context of each day.

---

### Monthly Memos files

In addition to writing to Daily Notes, Knomo also automatically maintains monthly Memos files for centralized browsing and archiving.

The default structure is similar to:

```md
# Knomo/Memos-2026-05.md
## [[2026-05-20]]
- 15:03:03 Today feels like having 37 browser tabs open. I need to write down the cache in my head, otherwise it will get messy tonight.
- 21:33:27 Today’s review: not every idea needs to be acted on immediately. Put it into a memo first and let it ferment on its own.
  
## [[2026-05-19]]
- 18:30:12 I came up with a new product idea today #idea
- 21:10:03 I found a great point while reading #reading
```

This serves two needs at the same time:

- Daily Notes preserve the context of each day;
- Monthly files provide a centralized view of the long-term memo stream.

---

### Card-based browsing

Knomo displays memos in a card flow, making it more suitable for quick review, scrolling, and lightweight filtering.

Compared with reading Markdown files directly, the card flow is better for:

- Quickly browsing recent notes;
- Viewing search results;
- Filtering by tags;
- Reading on mobile;
- Daily review.

---

### Tags and search

Knomo recognizes tags inside memos, for example:

```md
- 16:20:00 Knomo’s mobile input box should feel more like a bottom panel #knomo #interaction
```

You can quickly find related memos by tag or keyword. Knomo does not automatically organize tags for you; it preserves the original Markdown content you wrote.

---

### Import memos from existing Daily Notes

If you already use time-formatted lists in your Daily Notes, Knomo can recognize those list items and import them as memos.

For example:

```md
- 09:30 Read an interesting point about product design #reading
- 14:20 Thought of a mobile interaction improvement for Knomo #knomo
```

During import, Knomo tries to recognize existing time formats and avoid damaging your original Daily Note content.

---

### Images and links

Knomo tries to follow Obsidian / Markdown’s native syntax.

Image example:

```md
- 18:30:12 This is an inspiration screenshot ![[image.png]]
```

Link example:

```md
- 19:05:00 This idea can be connected to [[Product Design]] #product
```

---

### Mobile-friendly experience

Knomo treats Obsidian mobile as a core use case from the beginning, not as an afterthought.

Many memos happen away from the computer: ideas while walking, excerpts while reading, thoughts after meetings, or late-night flashes before sleep. Knomo aims to let these moments be captured quickly, reliably, and with minimal interruption on mobile.

Mobile-focused improvements include:

- A touch-friendly quick create entry;
- A smoother bottom input experience;
- Coordination between the input box and the system keyboard;
- Height and scrolling control when writing long content;
- Larger touch targets to reduce mis-taps;
- Card flow browsing on mobile;
- Mobile search entry;
- Sidebar drawer and tag filtering;
- Adaptation for Obsidian mobile navigation bars and safe areas.

Knomo’s goal is not just to “open on mobile,” but to make Obsidian mobile genuinely suitable for capturing memos on the go.

> Mobile compatibility will continue to improve. Feedback with specific devices, system versions, Obsidian versions, and reproduction steps is welcome.

---

### Theme compatibility and Minimal support

Knomo tries to build its interface with Obsidian theme variables so that it can adapt more naturally to different community themes.

It currently includes support for the Minimal theme, helping cards, input boxes, sidebars, popover menus, and mobile interfaces maintain a more consistent visual appearance under Minimal.

If you use other Obsidian themes, feedback is also welcome for display issues, spacing problems, color conflicts, or mobile styling issues.

---

## Installation

### Install from the Obsidian community plugin marketplace

> To be added after listing.

1. Open Obsidian Settings;
2. Go to “Community plugins”;
3. Turn off Restricted Mode;
4. Search for `Knomo`;
5. Install and enable the plugin.

### Manual installation

> This method will be available after a Release is published.

1. Download the latest versions of the following files:
   - `main.js`
   - `manifest.json`
   - `styles.css`
2. Create the following directory in your Vault:

```text
.obsidian/plugins/knomo/
```

3. Put the three files into this directory;
4. Restart Obsidian;
5. Enable Knomo in “Community plugins”;
6. Run `Open Knomo` from the command palette.

---

## Quick Start

### 1. Enable Daily Notes

Knomo depends on Obsidian’s core plugin **Daily Notes** to write memos into the Daily Note of the day.

Before using Knomo, please enable Obsidian’s core plugin “Daily Notes”.

Please make sure that:

- Obsidian’s core plugin “Daily Notes” is enabled;
- The Daily Notes folder path is configured;
- The date format is configured;
- Daily Note files can be created normally.

---

### 2. Set the memo insertion heading

The default heading is:

```md
## Memos
```

Knomo will write memos created on the current day under this heading.

If the heading does not exist in the Daily Note of the day, Knomo will try to create it according to your settings.

---

### 3. Open Knomo

You can open Knomo in the following ways:

- Click the Ribbon icon on the left;
- Run `Open Knomo` from the command palette;
- Pin the Knomo view to the sidebar or main workspace.

---

### 4. Create your first memo

Enter:

```text
Today I started using Knomo to capture fragmented thoughts #knomo
```

After saving, it will appear in the Knomo card flow and be written to the corresponding Markdown file.

---

## Markdown Format

Knomo tries to use a simple, readable, and portable Markdown format.

### Memo in Daily Note

```md
- 18:30:12 This is a memo
```

### Multi-line memo

```md
- 18:30:12 First line
	Second line
	Third line
```

### Memo with tags

```md
- 18:30:12 I read a great point today #reading #product
```

### Memo with image

```md
- 18:30:12 This is an inspiration screenshot ![[image.png]]
```

### Memo with Obsidian link

```md
- 18:30:12 An idea that can be connected to [[Product Design]] #idea
```

### Memo in monthly archive

```md
## [[2026-05-25]]

- 18:30:12 This is a memo
```

---

## Data and Privacy

Knomo’s core principle is: **your data belongs to you**.

- Memo content is stored in your Obsidian Vault;
- Markdown files can be read, backed up, and migrated directly;
- The plugin index is used to improve browsing, search, and sync experience;
- The plugin index is not the only source of data;
- Knomo does not rely on external servers;
- Knomo does not require account registration;
- Knomo does not actively upload your notes.

---

## Data Safety Notes

Knomo writes to your Markdown files. To reduce risk, please pay attention to the following in early versions:

- Back up your Vault before first use;
- If you use Obsidian Sync, Git, or another third-party sync tool, make sure the sync status is normal;
- Always back up before importing old content;
- If the Daily Note and Knomo card flow look inconsistent, check the original Markdown first;
- The plugin index can be rebuilt, while Markdown files are the long-term trusted source;
- Delete, restore, and import features may still change in early versions.

Knomo’s goal is not to hide Markdown, but to make Markdown easier to capture, browse, and reuse.

---

## Recommended Workflows

### Daily fragmented capture

Use Knomo as a quick input box inside Obsidian.

Write down whatever comes to mind first. There is no need to classify it immediately. Later, you can use tags, search, Daily Notes, and links to process it.

---

### Reading excerpts

```md
- 10:32:00 This sentence reminded me: the key to product design is not the number of features, but the path users take to complete their goals. #reading #product
```

---

### Project idea pool

```md
- 16:20:00 Knomo’s mobile input box should feel more like a panel above the keyboard. #knomo #interaction
```

Later, you can filter related ideas with `#knomo`.

---

### Daily review

Open the Daily Note at night and you will see all memos from that day.

These pieces of content can be further developed into:

- Daily reports;
- Project records;
- Long-form drafts;
- Product requirements;
- Task lists.

---

## Differences from Other Tools

### How is Knomo different from flomo?

flomo is a standalone Memos product. Knomo is an Obsidian plugin.

Knomo is more suitable for users who want to keep fragmented notes in their own Vault while continuing to use Obsidian’s tags, search, backlinks, and Markdown workflow.

Simply put:

> Knomo is not a replacement for flomo, but a local memo-first workflow for Obsidian users.

---

### How is Knomo different from Thino?

Thino is a mature Obsidian Memos plugin.

Knomo focuses more on:

- Daily Note integration;
- Local monthly Markdown collection;
- Mobile input experience;
- A low-friction personal memo workflow.

If you need a mature, complete, and feature-rich Memos plugin, you can consider Thino first.

If you want a lightweight capture entry that is closer to Daily Notes and local Markdown, you can try Knomo.

---

## FAQ

### Will Knomo lock my data inside the plugin?

No. Knomo’s core content is written to Markdown files. The plugin index is used to improve the experience, but it should not become the only source of data.

---

### Do I have to enable Daily Notes?

Yes. Knomo’s main workflow is built around Daily Notes.

If Daily Notes is not enabled, some writing features may not work properly.

---

### Will Knomo upload my notes?

No. Knomo does not rely on external servers and does not actively upload your notes.

---

### Does Knomo support mobile?

Yes, and mobile is one of Knomo’s key optimization directions.

Knomo does not simply shrink the desktop interface onto a phone. Instead, it includes dedicated interaction improvements for Obsidian mobile, including:

- A quick entry for creating memos;
- A bottom composer better suited for mobile input;
- Input experience coordinated with the system keyboard;
- Height and scrolling control for long content;
- Larger touch targets to reduce mis-taps;
- Mobile card flow browsing;
- Search page and tag filtering;
- Sidebar drawer;
- Adaptation for Obsidian mobile navigation bars;
- Optimization for safe areas, bottom navigation bars, and floating create buttons.

Knomo aims to bring the Obsidian mobile experience closer to that of a dedicated memo app.

Because Obsidian mobile, system keyboards, themes, and devices can differ significantly, specific feedback is welcome if you run into issues.

---

### Why do my card flow and Markdown files look inconsistent?

The index may not have refreshed yet, or the Markdown files may have been edited externally and not rescanned.

Suggestions:

1. Check the original Markdown first;
2. Try refreshing Knomo;
3. If the problem persists, submit an Issue with reproduction steps.

---

## Feedback and Contribution

Feedback and contributions are welcome, including:

- Bug reports;
- Feature suggestions;
- UI / UX improvement suggestions;
- Documentation improvements;
- Mobile experience feedback;
- Compatibility issues under different Obsidian themes.

---

## License

### Knomo for Obsidian Desktop and Mobile

Knomo is licensed under the MIT License. You are free to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of this software, as long as you preserve the copyright and license notice in any substantial portion of the code.

This includes any standalone snippets, styles, components, or utility functions you may extract from Knomo.

If you distribute a fork of Knomo or reuse part of its code, it would be appreciated if you keep a link back to the original project in your README and keep my [Buy me a coffee](https://www.buymeacoffee.com/banyanso) link.

Knomo is designed for Obsidian and may continue to be updated to stay compatible with new versions of Obsidian, including improvements for desktop, mobile, and community themes such as Minimal.

See the [LICENSE](./LICENSE) file for details.