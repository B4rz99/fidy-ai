---
version: alpha
name: Fidy
description: Durable visual foundations and reusable design patterns for Fidy.
colors:
  brand-green: "#88CC20"
  primary: "{colors.brand-green}"
  on-primary: "#141414"
  primary-hover: "#79B91B"
  primary-pressed: "#6BA414"
  secondary: "#FAE3D9"
  neutral: "#FFFAF6"
  surface: "#FFFFFF"
  on-surface: "#141414"
  text-secondary: "#514D48"
  heading-accent: "{colors.brand-green}"
  focus: "#141414"
  border: "#DED6CE"
  border-control: "#76716B"
  success: "#C5DFA5"
  warning: "#F5DFA0"
  error: "#F0B4AE"
  information: "#B8D4EF"
  pending: "#D2C4EC"
  on-pastel: "#171916"
  chart-sage: "{colors.success}"
  chart-sky: "{colors.information}"
  chart-peach: "{colors.secondary}"
  chart-lavender: "{colors.pending}"
  chart-butter: "{colors.warning}"
  chart-rose: "#E8BED5"
  dark-canvas: "#141414"
  dark-surface: "#202020"
  dark-raised: "#2E2E2E"
  dark-deep: "#141414"
  dark-border: "#606060"
  dark-border-control: "#858585"
  dark-focus: "#FFF6EF"
  dark-text: "#FFF6EF"
  dark-text-secondary: "#C7C7C7"
  dark-heading-accent: "{colors.brand-green}"
typography:
  headline-display:
    fontFamily: Poppins
    fontSize: 80px
    fontWeight: 600
    lineHeight: 1.08
    letterSpacing: -0.05em
  headline-lg:
    fontFamily: Poppins
    fontSize: 48px
    fontWeight: 600
    lineHeight: 1.15
    letterSpacing: -0.04em
  headline-md:
    fontFamily: Poppins
    fontSize: 24px
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: -0.025em
  body-md:
    fontFamily: Poppins
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.7
    letterSpacing: 0em
  body-sm:
    fontFamily: Poppins
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 0em
  label-md:
    fontFamily: Poppins
    fontSize: 14px
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: 0em
  caption:
    fontFamily: Poppins
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 0em
rounded:
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
  full: 9999px
spacing:
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 32px
  xxl: 48px
  page-gutter: 48px
  page-gutter-tablet: 24px
  page-gutter-mobile: 20px
  section: 104px
  section-mobile: 65px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.label-md}"
    rounded: "{rounded.full}"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
  button-dark:
    backgroundColor: "{colors.on-surface}"
    textColor: "{colors.secondary}"
    typography: "{typography.label-md}"
    rounded: "{rounded.full}"
  pricing-card:
    backgroundColor: "{colors.neutral}"
    textColor: "{colors.on-surface}"
    rounded: "{rounded.xl}"
    padding: 36px
---

# Fidy design

## Overview

Fidy makes personal finance feel clear, approachable, and under control. Poppins
typography, warm peach surfaces, confident ink text, and purposeful lime accents
give the product its character. The experience is calm, capable, and comfortable
to read, with personality supplied by the original wordmark and tití artwork.

### Scope

This document defines the shared visual language for the public website and
application: tokens, hierarchy, surfaces, components, and interaction treatments.
Keep changes here when they establish a reusable design rule. Feature workflows,
API contracts, component APIs, file ownership, test procedures, approval history,
and individual screen geometry belong in their respective specifications or code.
An implementation change alone does not establish a design-system rule.

The frontmatter records the palette and reusable public-site scale. Application
screens use the same visual foundations with the comfortable density below.
[Shared tokens](design/tokens.css) and the local `/ui-reference.html` component
reference provide the implemented treatments. Domain language is defined in
[GLOSSARY.md](GLOSSARY.md); application boundaries belong in
[ARCHITECTURE.md](apps/web/ARCHITECTURE.md).

### Voice and brand assets

Use Colombian Spanish (`es-CO`). Marketing can say “tu plata”; financial
explanations use precise domain terms. Use “hallazgos” in visible Spanish copy.
Explain outcomes and authorized access plainly. Product claims, prices, and
availability must reflect actual product decisions.

Use the supplied wordmark, coin, tití, and pastel ceiba artwork without redrawing
or changing their proportions. Preserve clear space and keep illustrations clear
of controls and financial text. Use the coin as a restrained brand motif.

## Colors

Light uses a warm off-white canvas, white surfaces, peach section changes, and
ink text. Grafito is the dark palette: neutral graphite surfaces, warm white text,
and the same lime accents. Distinguish nested surfaces through tone. Offer Light,
Dark, and System; follow the system by default and remember an explicit choice
consistently across the product.

Brand green is exactly `#88CC20` in both themes. Primary actions use ink labels,
`#79B91B` on hover, and `#6BA414` when pressed. Their border is ink in Light and
matches the fill in Grafito. Supporting chromatic accents are pastel. Use muted
foregrounds for supporting text, and distinguish control borders from quieter
decorative dividers.

### Contrast and meaning

Normal text needs at least 4.5:1 contrast and large text at least 3:1. Check each
actual foreground/background pair in both themes. Pastel indicators use dark
text; alerts and status badges use their paired semantic foreground and subtle
background. Pair state colors with labels or meaningful icons.

The homepage slogan “Tu vida, más tranquila” retains its approved lime-on-peach
treatment without a backing band. That pair is approximately 1.59:1 and is an
accepted contrast debt, limited to the light homepage slogan. It does not relax
contrast requirements for other text, controls, pages, or themes.

| Role        | Treatment               | Meaning                      |
| ----------- | ----------------------- | ---------------------------- |
| Success     | Sage / semantic green   | Confirmed successful outcome |
| Warning     | Butter / semantic amber | Attention or uncertainty     |
| Error       | Coral / semantic red    | Failure or exceeded limit    |
| Information | Sky / semantic blue     | Explanation or guidance      |
| Pending     | Lavender                | Awaiting review              |

Ordinary spending is not an error. Destructive actions and error feedback have
distinct roles even when both use the coral family.

### Financial graphics

Use the six `chart-*` pastels for categorical data. Keep a Category's color stable
across screens, periods, and label changes. A single series uses one color.
Labels, markers, and contrasting boundaries distinguish adjacent pastel regions.
Category emojis are permitted in category-grouped spending charts; full names and
exact values must remain available through keyboard, touch, and assistive text.
Other chart groupings retain readable text labels.

Balances and totals use the main foreground. Income and expenses have explicit
signs or direction labels. Budget progress uses lime within the limit, butter
when a product-defined warning applies, and coral when exceeded. Unallocated
income in a Budget summary may use green; negative allocation uses the semantic
error pair. Preserve labels for available, remaining, and exceeded amounts.

Use Colombian number formatting, tabular digits, and aligned comparable amounts.
Show Currency explicitly wherever a symbol is ambiguous; Budget figures use
Currency codes. Preserve exact fractional precision and keep different Currencies
separate. Charts start quantitative bars at zero and expose exact values without
relying on color or hover alone.

## Typography

Use Poppins with Arial and sans-serif fallbacks. Headings and action labels use
600; body text uses 400. Keep headline tracking tight and body tracking neutral.
Use the small set of roles consistently rather than accumulating one-off sizes.
Lead sections with their actual heading; decorative eyebrows are not a default.

The public-site display scale is:

| Role                        | Above 1100px | 701–1100px | Up to 700px |
| --------------------------- | ------------ | ---------- | ----------- |
| Hero headline               | 80px         | 64px       | 56px        |
| Section heading             | 48px         | 48px       | 36px        |
| Component title             | 24px         | 24px       | 22px        |
| Body                        | 16px         | 16px       | 16px        |
| Secondary text and controls | 14px         | 14px       | 14px        |
| Captions                    | 12px         | 12px       | 12px        |

Application screens use 16px reading text and a smaller heading hierarchy than
the landing. Editable text uses at least 1rem on compact layouts to preserve
readability and avoid focus zoom. Small illustration labels are not a precedent
for functional inputs. Allow wrapping, text enlargement, and browser zoom;
controls grow with their labels.

## Layout

Use aligned content edges, a clear reading order, and the 4–48px spacing scale.
Keep related controls close and separate larger groups through whitespace and
subtle dividers. Let content determine when columns collapse.

Public-site content normally caps at 1240px, expanding to 1320px on wide screens.
Gutters step from 48px to 24px to 20px. Standard section spacing is 104px on desktop
and 65px on mobile. These spacious marketing proportions do not transfer to
application data screens.

Application layouts use comfortable controls around 44–48px and record rows
around 56–64px as starting sizes. Keep amounts scannable and actions reachable.
Contextual editing planes sit beside the main content on wide screens and become
accessible full-width sheets when space is limited. Maintain a clear relationship
between a panel, its heading, and the content it affects.

Wrap toolbars and long labels. On narrow screens, tables may become unboxed
entries when that preserves the information hierarchy. Dense charts may scroll
locally; the page stays within the viewport. Respect safe areas and short
viewports. Keep important actions and explanatory feedback reachable with zoom.
Reserve illustration space so changing examples does not displace nearby content.

## Elevation & Depth

Build hierarchy with continuous canvases, adjacent tonal planes, aligned edges,
whitespace, and thin dividers. Ordinary data and form sections are unboxed;
avoid rounded perimeter cards or shadows around every section.

Dashboard widgets and public pricing retain their card treatments. These are
specific composition families, not a default container for application content.
Reserve functional elevation for floating surfaces such as menus, dialogs, and
the Agent conversation. Product illustrations may use soft shadows and overlap
to establish a foreground object.

## Shapes

Primary public-site actions and compact choice triggers use pills. Application
forms also use softly rounded rectangular controls, with 12px as the shared
control radius. Keep related controls consistent in shape across interaction
states. Use the radius scale deliberately; public pricing cards use 24px corners.
Screen-specific geometry does not create a new global radius.

## Components

### Actions and focus

Lime identifies the primary action. Outline and text treatments provide quieter
alternatives; dark pills remain available for public pricing and closing sections.
Selection, hover, pressed, disabled, and keyboard-focus states remain distinct.
Selection changes emphasis without changing control geometry or label weight.

Focus uses a contrasting 2px external outline with a 2px gap exposing the adjacent
surface. Keep disabled labels readable. Loading preserves control dimensions and
uses separate feedback when needed. Icon-only actions need an accessible name and
a comfortable hit area.

Destructive actions, including their confirmation initiators, normally use coral
fill and a contrasting dark label; hover and focus preserve that meaning. Neutral
cancellation stays neutral. Approved quieter variants use semantic red text or an
outline: Settings initiators and Transactions deletion review use these variants.
These exceptions do not redefine all destructive controls.

### Inputs, choices, and calendars

Use persistent labels, nearby helper text, and field-local errors. Placeholders
provide examples. Preserve entered values on failure and offer useful recovery.
Short single-choice menus show the selected option; long lists add search and an
explicit empty result. Multi-choice controls remain visibly distinct.

Calendars use Spanish labels, clear selected-day and today treatments, visible
focus, and readable disabled days. Numeric fields preserve local grouping and
decimal separators. Date fields use an unambiguous local-date presentation.

### Lists, navigation, and panels

Use consistent row alignment, comfortable spacing, and subtle separators.
Wrap names and notes without hiding amounts or actions. Selection and hover make
row interaction clear without changing financial meaning.

Keep the logo, navigation, and primary action distinct. Compact navigation has a
clear open state and predictable dismissal. Menus, disclosures, tabs, and sheets
support keyboard operation and visible selection. Panels provide a named close
action, focus entry and return, and Escape dismissal where appropriate.

### Feedback and conversation

Keep loading, empty, failure, uncertain outcome, and confirmed success visually
and verbally distinct. Retain loaded content during refreshes and pagination;
pending reads do not introduce skeletons or placeholder layouts. Preserve an
accessible pending status. Action submissions and external approvals keep their
own feedback. Never present an unconfirmed result as success.

The Agent conversation uses a floating nonmodal surface. User messages have lime
emphasis; assistant text stays plain and readable. Separate the composer from the
scrolling history, respect the reader's scroll position, and make returning to
the latest message explicit. Confirmation and recovery actions remain legible
within short and narrow viewports. Demonstrations clearly use example data.

### Icons and motion

Use Hugeicons outline with a consistent 1.5px stroke, normally 20px in controls and
24px standalone. Icons inherit readable foregrounds; pastel backing can supply
emphasis. Hide decorative icons from assistive technology. Category emojis in
charts and the supplied brand artwork are intentional exceptions to the icon family.

Motion explains an action and its result. Prefer finite opacity and transform
transitions with stable layout. Shared control timings are 150ms for fast feedback
and 200ms for standard transitions. Selection feedback is immediate. Honor reduced
motion by removing unnecessary travel, stagger, and decorative mascot movement.
Avoid continuous decorative loops and preserve focus through state changes.

## Do's and Don'ts

- Reuse the shared palette, type roles, shapes, and interaction states across screens.
- Keep financial meaning explicit in labels, Currency, and exact figures.
- Use flat workspace planes; reserve cards and elevation for their defined roles.
- Preserve readable text, contrast, focus, and reachable actions in both themes and
  at narrow widths, intermediate widths, and enlarged text.
- Use concrete product explanations and actual states; avoid invented assurances.
- Add lasting visual decisions here. Keep feature behavior, implementation notes,
  temporary exceptions, and delivery history with the relevant code, issue, or PR.

Document format: [Google DESIGN.md specification](https://github.com/google-labs-code/design.md/blob/main/docs/spec.md).
