---
name: VoxPilot popup
description: Compact voice control in the Chrome action popup.
colors:
  background: "#111a29"
  surface: "#1a2639"
  line: "#2e3c51"
  text: "#f0f4fa"
  muted: "#aab8cc"
  accent: "#2865d8"
  accent-hover: "#266ae3"
  active: "#71e0b0"
  busy: "#ffd28a"
  danger: "#ffb2af"
  focus: "#91baff"
  paused: "#8191a8"
  pause-background: "#233b39"
  pause-hover: "#2b4844"
  pause-text: "#c5f7e3"
  input-border: "#465871"
typography:
  title:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "14px"
    fontWeight: 650
    lineHeight: 1.5
    letterSpacing: "-0.02em"
  body:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  metadata:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  footer: "5px"
  control: "7px"
  toggle: "9px"
spacing:
  small: "6px"
  medium: "8px"
  section: "12px"
  activity: "16px"
  inset: "18px"
components:
  listening-start:
    backgroundColor: "{colors.accent}"
    textColor: "#fff"
    rounded: "{rounded.toggle}"
    padding: "10px 13px"
    width: "100%"
  listening-pause:
    backgroundColor: "{colors.pause-background}"
    textColor: "{colors.pause-text}"
    rounded: "{rounded.toggle}"
    padding: "10px 13px"
    width: "100%"
  secondary-button:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    padding: "6px 10px"
  input:
    backgroundColor: "{colors.background}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    padding: "7px 9px"
---

# Design System: VoxPilot popup

## Overview

This document covers the compact Chrome action popup in `src/panel/panel.html` and `src/panel/panel.ts`. Its navy utility interface puts listening state, the primary control, and the latest command within a short scan. It records the shipped popup system; other extension surfaces require their own design decisions.

The popup controls a persistent voice session. Its listening note explains that closing the popup leaves the microphone running. The reviewed default popup measures 340 × 270 CSS pixels.

## Colors

The dark navy background and muted blue-gray text establish a quiet base. Blue marks Start listening and contextual primary actions. The green-tinted Pause listening control communicates the active session.

Status dots use `paused`, `active`, `busy`, and `danger` alongside readable state labels. Green also marks command results and the microphone meter; danger text marks errors. Dividers use `line`; secondary hover surfaces use `surface`.

## Typography

Use the system font stack in the tokens. The product title is the small, semibold top-level anchor. Body text and section headings use the body size; headings use weight 600. Status, helper copy, progress, inputs' labels, and secondary controls use the metadata size. The primary listening control uses weight 600; contextual buttons use weight 500.

Keep the transcript at body size with line-height 1.55. Download percentages use tabular numerals. The shortcut retains the native `kbd` monospace treatment.

## Layout

Use one column at a fixed width of 340px. The header and main content share the inset token. Arrange the header, full-width listening control, listening note, activity, contextual sections, and footer in that order. The header holds the product at left and status at right.

Preserve the compact default height while allowing model progress, errors, confirmations, vault unlock, and Commands & help to expand the popup when relevant. Long transcripts, results, and plans wrap and scroll within their existing bounded areas. Contextual sections use a top divider and the section spacing token. Footer actions sit at opposite ends.

## Elevation & Depth

The popup uses a flat canvas, subtle dividers, and tonal hover fills. No internal shadows or floating cards are used. Chrome supplies the popup's outer container.

## Shapes

Use the toggle radius for the main listening control, the control radius for contextual buttons and inputs, and the smaller footer radius for utility actions. Status dots are circular; microphone bars and progress tracks have small rounded ends. Keep line icons thin, unfilled, and 18px square.

## Components

- **Listening control:** Full width, at least 44px high, with a leading microphone or pause icon and trailing Alt+V shortcut. The blue Start state becomes green-tinted Pause when listening is enabled.
- **Status and microphone meter:** Pair the 6px state dot with text. The five small meter bars passively reflect audio level only while listening; the meter is not a control.
- **Activity and model status:** Show the latest transcript, then a contextual result. Model preparation uses metadata text and a thin 3px progress track; show numeric progress only for measurable downloads.
- **Confirmation and vault:** Reveal inline sections when required. Keep Cancel and the primary action side by side. Vault unlock uses a labeled password field with at least 36px height; contextual buttons have at least 34px height.
- **Footer and commands:** Keep Settings and Commands & help as quiet text actions with at least 32px height. Commands expands an inline section with examples and a command input.
- **Interaction states:** Use a visible 2px focus outline in `focus` with a 3px offset. The listening control's background transition is 120ms ease. Disabled buttons use 0.65 opacity and a wait cursor. Respect reduced-motion preferences for transitions and model progress animation.

## Do's and Don'ts

- **Do** keep listening state and its primary control visible before contextual content.
- **Do** pair status color with explicit text and keep the persistent microphone explanation close to the control.
- **Do** reveal confirmation, vault, error, and help content only when relevant.
- **Don't** turn the compact popup into a dashboard or introduce a new product-wide identity through this document.
- **Don't** imply that closing the popup pauses listening.
