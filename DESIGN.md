---
version: alpha
name: Fidy
description: Brand foundations and approved public website and application patterns for Fidy.
colors:
  brand-green: "#7CB243"
  primary: "{colors.brand-green}"
  on-primary: "#000000"
  primary-hover: "#8ABE53"
  secondary: "#FAE3D9"
  neutral: "#FFFAF6"
  surface: "#FFFFFF"
  on-surface: "#000000"
  text-secondary: "#514D48"
  heading-accent: "#537C2D"
  focus: "#497423"
  border: "#E3D7CE"
  demo-timestamp: "#62695C"
  demo-placeholder: "#6B6862"
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
  dark-text: "#FFF6EF"
  dark-text-secondary: "#C7C7C7"
  dark-heading-accent: "{colors.secondary}"
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
  demo-label:
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

Fidy makes personal finance feel clear, approachable, and under control. Expressive
Poppins typography, warm peach surfaces, confident black text, and purposeful green
accents give the product its character. The experience should feel calm and capable,
with enough personality to make financial organization approachable.

Fidy is an agent-first personal finance product for Colombia. Financial records,
budgets, and hallazgos share one system, usable through conversation, the web
application, and a person's own authorized agents. Product explanations should make
those relationships tangible through examples.

### Scope and authority

This edition records the approved public landing, its feature detail pages, and the transaction workspace.
Brand colors, typography, and voice are foundations for future product design. The
marketing layouts and illustrative dashboards are not specifications for the
application's working screens. Preserve existing application conventions until those
screens receive their own design decisions.

The tokens define reusable defaults; the sections below explain their roles and
responsive exceptions. The implementation contains additional illustration-specific
values that are not new system tokens. Update this document with approved changes to
the shared visual language, rather than treating every CSS value as a universal rule.

The approved light and Grafito themes, pastel accents, financial color conventions,
icon family, and comfortable application density are defined below. These establish
design defaults; existing application screens still need a deliberate implementation
and review. The approved transaction workspace and shared application patterns are recorded below; other screen compositions remain deliberate design work.

### Voice

Use Colombian Spanish (`es-CO`) in the product. Marketing can say “tu plata”; precise
financial explanations use transactions, categories, budgets, and their actual
relationships. Use “hallazgos” in visible Spanish copy instead of “insights.” Refer to
[GLOSSARY.md](GLOSSARY.md) for domain definitions.

Show COP clearly where currency would otherwise be ambiguous, with Colombian number
formatting such as `$28.000 COP`. Explain what an agent can do and what access the user
authorizes. Claims about channels, privacy, integrations, pricing, or availability
must match the current product decisions. Launch prices and temporary registration
behavior belong in product content, not permanent design tokens.

## Colors

Black provides the strongest hierarchy. Off-white is the default canvas; peach creates
warm, broad section changes. The original brand green marks important actions and selected accents.
White surfaces help illustrative financial records stand out.

Use `heading-accent` for the large green headline emphasis. Use `text-secondary` for
supporting prose. The original green is shared by the logo, actions, and progress accents. Supporting colors use the pastel
family; muted dark text and structural neutrals remain available for legibility.

Keep normal text at a contrast ratio of at least 4.5:1 and large text at least 3:1.
Check the actual foreground/background pair, including tinted chat bubbles. The two
demo text colors preserve readability for timestamps and the illustrated composer.
Pair color with labels, selection states, or icons when it carries meaning.

### Themes and semantic accents

Light retains the original off-white canvas and peach sections. Dark uses neutral graphite
surfaces with warm text, peach emphasis, and brand-green actions. Distinguish nested product
surfaces by tone; light peach messages and budget cards can remain luminous within
a dark illustration. Reserve subtle background illumination for the landing hero.
Offer Light, Dark, and System, following the system by default and remembering the
user's explicit choice. Apply the chosen theme to feature detail pages as well.

Supporting chromatic accents are pastel. Brand green (`#7CB243`) is the explicit
exception for primary actions and progress in both themes. Neutrals provide readable text, borders,
and dark backgrounds. Never apply pastel text directly to a pale surface without
checking contrast. Use dark text on pastel fills in both themes.

| Role        | Token         | Example                        |
| ----------- | ------------- | ------------------------------ |
| Success     | `success`     | Transaction saved              |
| Warning     | `warning`     | Budget approaching its limit   |
| Error       | `error`       | Save failed or budget exceeded |
| Information | `information` | An explanatory message         |
| Pending     | `pending`     | A record needing review        |

Pair every state with a label or icon. Color alone cannot communicate an error,
selection, or financial outcome. A normal expense is not an error.

### Financial graphics and figures

Use the six `chart-*` colors for categorical data. A category retains its assigned
color across screens and periods. A single series uses one color; do not alternate
colors between bars of the same series merely for decoration. Use labels, markers,
and contrasting boundaries so adjacent pastel regions remain distinguishable.

Balances and totals use the main text color. Income and expenses use explicit signs
and labels, with optional pastel indicators nearby. Distinguish spending, budget
limits, and remaining amounts. Budget progress uses brand green within its limit, butter
when the product's warning condition applies, and coral after exceeding it; design
must not invent the numerical warning threshold.

Use tabular digits and align comparable amounts. Show currency where needed and
preserve the domain's precision; formatting must not change a financial value.

## Typography

Use Poppins, locally bundled with its license; Arial and sans-serif are fallbacks.
Headings use weight 600. Body copy uses 400, and action labels use 600. Reserve heavier
weights for financial figures or deliberate emphasis within product illustrations.

| Role                        | Above 1100px | 701–1100px | Up to 700px |
| --------------------------- | ------------ | ---------- | ----------- |
| Hero headline               | 80px         | 64px       | 56px        |
| Section heading             | 48px         | 48px       | 36px        |
| Component title             | 24px         | 24px       | 22px        |
| Body                        | 16px         | 16px       | 16px        |
| Secondary text and controls | 14px         | 14px       | 14px        |
| Demo labels                 | 12px         | 12px       | 12px        |

Use this small hierarchy consistently across sections. Eyebrows are not part of the
default section pattern: lead with the actual heading. Compact text inside scaled
product illustrations is a special case, not a size to reuse for functional controls.
Keep headline tracking tight and body tracking neutral. Let text wrap naturally at
narrow widths; preserve intentional hero line breaks only where they remain readable.

## Layout

Use spacious sections, aligned content edges, and grids with a clear reading order.
The standard content width is capped at 1240px, with 48px side gutters. Gutters reduce
to 24px at 1000px and 20px at 700px. The existing wide-screen treatment permits a 1320px
cap from 1600px. These are public-site layout rules.

Standard sections have 104px vertical padding on desktop and 65px on mobile. The hero
and closing sections have their own composition. Use the spacing tokens for recurring
relationships; illustration geometry may need optical adjustments.

Collapse the main navigation into its menu at 1100px before labels become cramped.
Stack the hero at 700px. Other grids collapse according to their content needs.
Buttons and their arrows stay together; important actions must not become awkward
multi-line fragments. Feature tabs may scroll horizontally on narrow screens while
the page itself stays within the viewport.

Interactive demonstrations reserve their space. Changing a conversation, selected
feature, or example record must not resize the phone or unexpectedly displace nearby
content. Keep the phone compact and the floating budget card legible. The current
short conversations should fit without requiring an internal scroll to understand
their outcome. On wide layouts, vertically center the FAQ heading beside its list.

Review mobile, intermediate, and desktop widths, including 390px, 715px, and 1440px.
Check between breakpoints and with enlarged text, not only at those sample sizes.

### Application density

Use a comfortable application layout: 16px reading text, 44–48px controls, and
56–64px transaction rows as starting sizes. Allow rows and controls to grow for
wrapped text and zoom. Keep amounts easy to scan and actions easy to reach. The
landing's oversized headings and section spacing do not transfer to data screens.

## Elevation & Depth

Use background changes, spacing, and thin borders for most hierarchy. Reserve layered
surfaces and shadows for product demonstrations and genuinely floating UI.

The phone uses a soft `0 28px 60px #312E251F` shadow; the floating budget card uses
`0 12px 30px #0000000C`. These establish a foreground object without making every
section a raised card. The slight phone tilt and overlapping card belong to the hero
illustration, not ordinary form or data surfaces.

## Shapes

Use pill-shaped primary actions, compact selection controls, and softly rounded
product surfaces. The radius tokens are recurring choices, not a requirement to give
every surface a different radius. Pricing cards use 24px corners. Existing illustrated
chat, phone, and dashboard geometry may retain their specific radii.

Use the supplied Fidy wordmark. Preserve its proportions and clear
space; do not reconstruct the logo using ordinary text. The logo's coin is a brand
motif, not a decoration to repeat throughout every section.

## Components

### Icons

Use Hugeicons through the installed React packages, with the outline family and a
consistent 1.5px stroke. Default to 20px in controls and 24px for standalone icons.
Let icons inherit readable text color; pastel backgrounds can provide emphasis.
Decorative icons are hidden from assistive technology, and icon-only buttons have
an accessible name and a sufficient hit area. Base UI supplies component behavior;
Hugeicons supplies the icon artwork.

### Forms and states

Use persistent labels for amount, category, date, and other transaction fields.
Place helper text and errors beside the affected field. A placeholder is an example,
not a replacement for its label. Focus has a visible contrasting outline.

Loading preserves the control's dimensions and identifies the action in progress.
Disabled controls remain readable and explain unavailable actions when necessary.
On failure, keep entered values and offer a useful correction or retry. Confirm
success only after the operation succeeds. Empty states explain what is missing and
offer the next relevant action; they are distinct from loading and network failure.
Use the semantic pastel family for feedback with readable text and meaningful icons.

### Navigation and actions

Keep the logo, navigation, and primary action visually distinct. The compact menu
has an explicit open state, keyboard support, and a predictable close interaction.
Green pill buttons identify the main entry action; dark pills work within pricing
and closing compositions. Secondary actions use a quieter underlined text link.
Keep arrow icons aligned with their labels and visible focus separate from hover.

### Product exploration

Feature tabs pair a clear title and short explanation with a concrete product view.
Each feature can lead to a dedicated page with deeper examples. Support arrow-key
navigation and an identifiable selected tab. The view should explain how the feature
helps the user, including how authorized agents participate where relevant.

Conversation, dashboard, and correction demonstrations use clearly identified example
data. Controls update that local example and make the result visible. Financial
figures stay aligned and distinguish recorded spending, budget limits, and remaining
amounts. Avoid implying that illustrative controls save real transactions.

### Pricing and questions

Pricing uses a prominent amount, explicit currency and billing period, and a clear
selected period. Explain recurring billing beside the decision. Retrieve current
amounts and terms from the product's approved content.

FAQs use direct user questions, restrained separators, and an obvious disclosure
control. Preserve keyboard behavior and readable expanded answers. Privacy statements
must describe actual behavior; design polish is not a reason to invent assurances.

### Motion

Motion connects an action to its result and gives the landing a measured sense of
life. Prefer finite opacity and transform transitions; keep layout dimensions stable.

| Interaction           | Current reference                     |
| --------------------- | ------------------------------------- |
| Section entrance      | 500ms, short upward movement and fade |
| Hero content sequence | 60ms stagger                          |
| Phone entrance        | 600ms                                 |
| Conversation bubble   | 280ms, 550ms between message starts   |
| Feature panel change  | 220ms, 6px upward movement            |

The entrance curve is `cubic-bezier(0.23, 1, 0.32, 1)`. Conversation timing is for a
readable demonstration, not a required delay in the working application. Selection
feedback should respond immediately. Switching examples restarts the relevant sequence
and cancels interrupted animations; it does not replay unrelated sections.

Keyboard feature changes are immediate. With reduced motion, entrances use a short
160ms fade without movement or stagger; retain immediate state changes and remove
unnecessary travel. Avoid continuous decorative loops. Clean up animations when their
view leaves, and preserve focus during state changes and dialog dismissal.

## Do's and Don'ts

- Use the established typography roles and section rhythm; avoid accumulating one-off
  font sizes or decorative eyebrows.
- Show concrete product behavior and clear outcomes; avoid vague AI promises.
- Make conversation, the web application, and authorized agents visible in the product
  story without turning every section into technical documentation.
- Preserve stable demo geometry; do not enlarge the phone simply to accommodate a
  longer example or move the floating card casually.
- Keep the page spacious and readable at intermediate widths; do not force desktop
  grids into insufficient space.
- Keep financial meaning explicit in text; do not rely on color alone.
- Treat detailed application layouts as open design work; apply the documented
  themes, semantic colors, icons, and density without inventing product behavior.

Implementation reference: [public-site landing](apps/web/src/features/public-site/landing/).
Application foundation: [shared theme](apps/web/src/index.css) and
[UI primitives](apps/web/src/ui/components/). Review the local `/ui-reference.html` page
and [frontend polish audit](docs/design/frontend-polish.md) before extending screen layouts.
Document format: [DESIGN.md specification](https://github.com/google-labs-code/design.md/blob/main/docs/spec.md).

## Signed-in transaction workspace

The approved transaction reference establishes the layout, while the shared Fidy
tokens above establish its visual language. Use Poppins, brand-green primary actions
with dark text, warm off-white and peach surfaces, and readable dark icons on pastel
indicators. Normal spending is not an error. Use the supplied wordmark and the shared
button, input, radius, and focus conventions; do not introduce a separate application
palette or font.

The sidebar is 240px wide; the desktop detail/summary rail is 384px wide with a
shared full-height divider. Comfortable rows use 16px text and group by long local
dates with currency-specific daily net totals. The right rail shows transaction
identity above correction fields, and a detailed summary when browsing. Preserve
this composition when applying the shared light and Grafito theme tokens.

Below 768px, application navigation uses the landing's floating, dismissible menu
instead of a scrolling horizontal navigation bar. Transaction names and categories
wrap when necessary. Columns share their alignment across rows, with Tipo visible
from a 481px ledger width (521px viewport with the phone gutters) and a separate Categoría column from 600px. Smaller ledgers
stack identity and amount below 400px; phone toolbars fill their available rows.

The summary omits the transaction-count footer and supporting subtitle. First and
last transaction dates use `dd-mm-yyyy`. A COP-only summary omits repeated currency
codes and its currency heading; mixed-currency summaries retain separate labeled
groups and explicit codes so amounts remain unambiguous. Exact fractional precision
is preserved in every case.

Transaction filters, sorting, capture, and single/bulk correction use the same
dismissible radio-menu pattern. Columns uses checkbox items in that same menu.
Toolbar filter triggers use the compact labels Transacciones and Categorías; the
menus retain the full option labels. Fecha opens a Spanish calendar immediately, with day
selection and an explicit clear action. Editar varias enables selection before
replacing the summary with a shared correction form. Unchanged fields retain each
record's value; corrections use the canonical atomic batch limit and observed
revisions, and uncertain saves are never retried automatically.

Transaction amounts display locale-aware currency symbols rather than currency
codes. Canonical Money retains its currency and exact amount. Selecting a ledger
identity or amount opens correction directly. Search expands in the header without
changing filter visibility. Form dates and Fecha share one Spanish calendar.

## Application components and patterns

The approved transaction workspace is the working application reference. New views
reuse its controls, geometry, interaction feedback, and shared light/Grafito tokens.
The landing remains the reference for public-site composition. A working screen
may have a different content layout; it does not introduce its own palette, font,
control radius, calendar, or dropdown appearance.

### Shared component ownership

Import components directly from `@/ui/components/<file>`, without a barrel or a
feature-private import. Components receive values, accessible labels, children,
and callbacks. Features own canonical queries, mutations, revision checks,
selection limits, filtering, and save outcomes. A dropdown selection is an intent;
the shared component never decides whether or how to persist it.

| Pattern          | Shared implementation                                       | Contract                                                                                                                                                                                              |
| ---------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Single choice    | `choice-dropdown.tsx`: `ChoiceDropdown`                     | Outline pill, optional leading visual, explicit accessible label, selected radio item, shared keyboard and dismissal behavior. `width` selects full-width fields or automatic-width toolbar controls. |
| Inline choice    | `choice-dropdown.tsx`: `InlineChoiceDropdown`               | Plain icon and label, no pill or chevron. Hover, focus, and open feedback reveal interactivity. Uses the same radio menu; the feature decides what selection does.                                    |
| Choice menu      | `choice-dropdown.tsx`: `ChoiceMenuOptions`                  | Shared radio options for composed triggers; Columns retains checkbox items in the same `DropdownMenu` primitive.                                                                                      |
| Calendar         | `calendar-field.tsx`: `CalendarField`                       | Spanish single-day calendar opens immediately. The caller supplies the IANA time zone and ISO local date; fields display `dd-mm-yyyy`. Required dates cannot be cleared.                              |
| Header search    | `header-search.tsx`: `HeaderSearch`                         | Replaces Buscar with a focused input. Escape closes the input while retaining the query. Query and open state belong to the caller.                                                                   |
| Indicators       | `icon-indicator.tsx`: `IconIndicator`, `DirectionIndicator` | Hugeicons outline at 1.5px, readable dark icons on semantic pastel fills. Named plain/category/category-large/direction treatments replace per-view dimensions. Adjacent text conveys meaning.        |
| Page header      | `workspace-layout.tsx`: `WorkspaceHeader`                   | 24px Poppins title, aligned actions, 20px gutters. Actions become a two-column grid on phones. Context and actions are caller-supplied.                                                               |
| Record controls  | `workspace-layout.tsx`: `RecordToolbar`                     | One wrapping control flow, compact horizontal padding, consistent 8px gaps. Filters and actions share the available row.                                                                              |
| Content and rail | `workspace-layout.tsx`: `WorkspaceColumns`                  | Flexible content and a 384px rail from 1280px; stacked content below that viewport width.                                                                                                             |
| Responsive panel | `workspace-panel.tsx`: `WorkspacePanel`                     | Desktop rail, stacked browsing summary, full-screen sheet for active work on smaller screens. The caller supplies title, description, close action, and save lock.                                    |

The application shell already owns the shared wordmark, sidebar, and floating
phone navigation. Reuse that shell for signed-in views rather than copying it
into each feature. `Button`, `Input`, `Label`, `Alert`, `Empty`, `Skeleton`, and
the overlay primitives remain the base controls; preserve their named variants,
focus rings, comfortable hit areas, and disabled treatments.

Category-to-illustration mapping stays with its feature; an indicator never assigns
or infers canonical Category identity. Financial values use the existing exact
Money formatter at the transport presentation seam. UI components accept formatted
text and never round, add, or reinterpret canonical amounts. Keep comparable amounts
aligned with tabular digits, explicit currency where ambiguous, and direction icons
next to compact amounts when their separate type column is hidden.

### Enforcement and reference

`/ui-reference.html` demonstrates the shared tokens, control states, search,
choice menus, calendar, indicators, and workspace composition using local example
data. Extend this reference when approving a new reusable treatment, including
keyboard behavior, light/Grafito appearance, and narrow layouts.

The root `.oxlintrc.json` runs `@shadcn/lint` in normal lint and CI. Raw colors and
arbitrary non-layout values are rejected. `no-restyle` contracts reserve component
colors, typography, shape, focus, and control spacing for the UI owner. Pages may
place controls; use component props and named variants for their appearance, or
put surrounding spacing on a parent. Shared implementations can define their own
styles inside `src/ui/components`; that exception is not permission for a view to
copy a control and restyle it.

Approved design changes update the shared component, its reference example, and
this document together. Lint enforces configured styling rules; rendered interaction
and responsive checks still verify behavior and composition. The transaction
workspace remains a regression reference while these components are reused elsewhere.

Selecting any transaction identity, type, or amount opens correction directly;
switching records remains possible while no save is pending. Selecting a category
from the desktop ledger uses an inline menu and saves that correction directly,
without opening the panel. Income/expense icons precede compact amounts below the
481px ledger threshold. Category triggers highlight on hover and while open.

### Compact management tables

Active-token management uses the shared `Table` with one row per token: name and safe short code,
permissions, creation, last use, expiration, and action. Use `density="compact"` on `TableHead`
and `TableCell` for 14px text, 8px horizontal padding, and 12px body-cell vertical padding.
Show dates as `dd-mm-yyyy` without times; retain the full UTC instant in each `time` element’s
`dateTime` attribute. Use “Nunca” for tokens that have never been used and wrap names readably.
On narrow screens, scroll
the table within its container; keep the page width stable. One-token deactivation confirmation
occupies a full-width row beneath that token. Default table density remains unchanged.

### Floating Agent conversation

The signed-in shell exposes a green, circular Agent launcher at the bottom right, with a comfortable
48px target and safe-area clearance. It opens a non-modal chat above the launcher, using
`ChatWindow` and `ChatComposer` from `ui/components/chat.tsx`. The panel fits the viewport on phones,
uses existing Fidy surface, border and focus tokens, and supports Escape, a labeled close action,
and reduced motion. It leaves the underlying workspace usable.

AI Elements `Conversation` and `Message` live in `ui/components/ai-elements`, adapted to the local
aliases, Hugeicons and branded controls. Conversation scrolling stays immediate, honors a reader's
position, and offers a labeled jump-to-latest control. User entries use peach bubbles; assistant text
stays plain and readable. Enter sends, Shift+Enter inserts a line, and composing IME text cannot send.
The feature owns the draft, bounded session-only history, pending status and explicit delivery receipt;
closing the panel preserves those values and never acknowledges a hidden reply. The UI advertises
only text capabilities supported by the existing Agent endpoint.
