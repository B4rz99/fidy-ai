# RealtimeKit Patterns

## UI Kit (Minimal Code)

## UI Components

RealtimeKit provides 133+ pre-built Stencil.js Web Components with framework wrappers:

### Layout Components

- `<RtkMeeting>` - Full meeting UI (all-in-one)
- `<RtkHeader>`, `<RtkStage>`, `<RtkControlbar>` - Layout sections
- `<RtkSidebar>` - Chat/participants sidebar
- `<RtkGrid>` - Adaptive video grid

### Control Components

- `<RtkMicToggle>`, `<RtkCameraToggle>` - Media controls
- `<RtkScreenShareToggle>` - Screen sharing
- `<RtkLeaveButton>` - Leave meeting
- `<RtkSettingsModal>` - Device settings

### Grid Variants

- `<RtkSpotlightGrid>` - Active speaker focus
- `<RtkAudioGrid>` - Audio-only mode
- `<RtkPaginatedGrid>` - Paginated layout

**See full catalog**: https://docs.realtime.cloudflare.com/ui-kit

## Core SDK Patterns

### Basic Setup

```typescript
import RealtimeKitClient from "@cloudflare/realtimekit";

const meeting = new RealtimeKitClient({ authToken, video: true, audio: true });
meeting.self.on("roomJoined", () => console.log("Joined:", meeting.meta.meetingTitle));
meeting.participants.joined.on("participantJoined", (p) => console.log(`${p.name} joined`));
await meeting.join();
```

### Video Grid & Device Selection

## Waitlist Handling

```typescript
// Monitor waitlist
meeting.participants.waitlisted.on("participantJoined", (participant) => {
  console.log(`${participant.name} is waiting`);
  // Show admin UI to approve/reject
});

// Approve from waitlist (backend only)
await fetch(
  `https://api.cloudflare.com/client/v4/accounts/${accountId}/realtime/kit/${appId}/meetings/${meetingId}/active-session/waitlist/approve`,
  {
    method: "POST",
    headers: { Authorization: `Bearer ${apiToken}` },
    body: JSON.stringify({ user_ids: [participant.userId] }),
  }
);

// Client receives automatic transition when approved
meeting.self.on("roomJoined", () => console.log("Approved and joined"));
```

## Audio-Only Mode

## Addon System

```typescript
// List available addons
meeting.plugins.all.forEach((plugin) => {
  console.log(plugin.id, plugin.name, plugin.active);
});

// Activate collaborative app
await meeting.plugins.activate("whiteboard-addon-id");

// Listen for activations
meeting.plugins.on("pluginActivated", ({ plugin }) => {
  console.log(`${plugin.name} activated`);
});

// Deactivate
await meeting.plugins.deactivate();
```

## Backend Integration

### Token Generation (Workers)

```typescript
export interface Env {
  CLOUDFLARE_API_TOKEN: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  REALTIMEKIT_APP_ID: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/join-meeting") {
      const { meetingId, userName, presetName } = await request.json();
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/realtime/kit/${env.REALTIMEKIT_APP_ID}/meetings/${meetingId}/participants`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
          },
          body: JSON.stringify({ name: userName, preset_name: presetName }),
        }
      );
      const data = await response.json();
      return Response.json({ authToken: data.result.authToken });
    }

    return new Response("Not found", { status: 404 });
  },
};
```

## Best Practices

### Security

1. **Never expose API tokens client-side** - Generate participant tokens server-side only
2. **Don't reuse participant tokens** - Generate fresh token per session, use refresh endpoint if expired
3. **Use custom participant IDs** - Map to your user system for cross-session tracking

### Performance

1. **Event-driven updates** - Listen to events, don't poll. Use `toArray()` only when needed
2. **Media quality constraints** - Set appropriate resolution/bitrate limits based on network conditions
3. **Device management** - Enable `autoSwitchAudioDevice` for better UX, handle device list updates

### Architecture

1. **Separate Apps for environments** - staging vs production to prevent data mixing
2. **Preset strategy** - Create presets at App level, reuse across meetings
3. **Token management** - Backend generates tokens, frontend receives via authenticated endpoint

## In This Reference

- [README.md](README.md) - Overview, core concepts, quick start
- [configuration.md](configuration.md) - SDK config, presets, wrangler setup
- [api.md](api.md) - Client SDK APIs, REST endpoints
- [gotchas.md](gotchas.md) - Common issues, troubleshooting, limits
