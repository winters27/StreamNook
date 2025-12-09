# Drops UI Overhaul - Implementation Plan

> **Status:** In Progress  
> **Last Updated:** December 9, 2025

## Overview

Refactor the Drops Center to provide a polished, consistent UI with clear progress visibility using a side panel detail view pattern. The goal is to match the design language established in `Home.tsx` while providing an intuitive "Library of Games with Drops" experience.

---

## Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Detail View Pattern | Side Panel (slides from right) | Familiar pattern, keeps context of game grid visible |
| Progress Visibility | Prominent 6px bar with shimmer | Critical for UX - users must see mining progress |
| File Structure | Multiple components | Cleaner code, easier maintenance |
| Badge Styling | `drops-badge-glass-lg` | Consistent with existing design system |

---

## File Structure

```
src/components/
├── DropsCenter.tsx              # Main container (refactored)
├── drops/
│   ├── ChannelPickerModal.tsx   # (existing - no changes)
│   ├── MiningStatus.tsx         # (existing - no changes)
│   ├── GameCard.tsx             # NEW: Individual game card
│   ├── GameDetailPanel.tsx      # NEW: Side panel for selected game
│   ├── DropsStatsTab.tsx        # NEW: Statistics content
│   └── DropsSettingsTab.tsx     # NEW: Settings content
```

---

## Component Specifications

### 1. GameCard.tsx

**Purpose:** Display a single game with drops, showing visual progress and status badges.

**Props:**
```typescript
interface GameCardProps {
  game: UnifiedGame;
  progress: DropProgress[];
  miningStatus: MiningStatus | null;
  isSelected: boolean;
  onClick: () => void;
}
```

**Visual Elements:**
- Glass panel card with hover effects
- Portrait aspect ratio (3:4) for game art
- Image zoom on hover (scale-105)
- Status badges (ACTIVE, MINING, CLAIM)
- Progress bar (always visible section, 6px height)
- Game name and item count

**Badge Logic:**
- `ACTIVE` - Game has active campaigns
- `MINING` - Currently being mined
- `CLAIM` - Has drops ready to claim (animated bounce)

---

### 2. GameDetailPanel.tsx

**Purpose:** Slide-in side panel showing detailed drop information for a selected game.

**Props:**
```typescript
interface GameDetailPanelProps {
  game: UnifiedGame;
  progress: DropProgress[];
  miningStatus: MiningStatus | null;
  isOpen: boolean;
  onClose: () => void;
  onStartMining: (campaignId: string, gameName: string) => void;
  onStopMining: () => void;
  onClaimDrop: (dropId: string) => void;
}
```

**Sections:**
1. **Header** - Game name, box art thumbnail, close button
2. **Mining Status** - If currently mining this game, show progress
3. **Active Campaigns** - List of campaigns with individual drops
4. **Your Collection** - Inventory items earned for this game

**Animations:**
- Slide in from right (300ms ease-out)
- Slide out on close

---

### 3. DropsStatsTab.tsx

**Purpose:** Display statistics and leaderboard.

**Content:**
- Stats grid (Drops Claimed, Points Earned, Active Campaigns, In Progress)
- Current mining status card
- Channel Points Leaderboard

---

### 4. DropsSettingsTab.tsx

**Purpose:** Drops automation settings.

**Content:**
- Auto-claim toggles (Drops, Channel Points)
- Auto-mining toggle
- Priority strategy dropdown
- Priority games list
- Excluded games list

---

### 5. DropsCenter.tsx (Refactored)

**Responsibilities:**
- Authentication flow
- Data fetching (campaigns, progress, inventory, settings)
- Tab navigation
- Layout orchestration
- State management for selected game

**Layout:**
```
┌──────────────────────────────────────────────────────────┐
│  Header: [Games] [Stats] [Settings]         [Search] [X] │
├───────────────────────────────────────┬──────────────────┤
│                                       │                  │
│   Game Cards Grid                     │  Detail Panel    │
│   (responsive columns)                │  (320px fixed)   │
│                                       │                  │
│   - GameCard components               │  - GameDetailPanel│
│   - Click to select                   │  - Slides in/out │
│                                       │                  │
└───────────────────────────────────────┴──────────────────┘
```

---

## CSS Additions

Add to `globals.css`:

```css
/* Shimmer animation for progress bars */
@keyframes progress-shimmer {
  0% { background-position: -200% 0; }
  100% { background-position: 200% 0; }
}

.animate-progress-shimmer {
  background: linear-gradient(
    90deg,
    var(--color-accent) 0%,
    var(--color-accent-hover) 50%,
    var(--color-accent) 100%
  );
  background-size: 200% 100%;
  animation: progress-shimmer 1.5s ease-in-out infinite;
}

/* Side panel slide animation */
@keyframes slide-in-right {
  from { transform: translateX(100%); opacity: 0; }
  to { transform: translateX(0); opacity: 1; }
}

@keyframes slide-out-right {
  from { transform: translateX(0); opacity: 1; }
  to { transform: translateX(100%); opacity: 0; }
}

.animate-slide-in-right {
  animation: slide-in-right 0.3s ease-out forwards;
}

.animate-slide-out-right {
  animation: slide-out-right 0.3s ease-in forwards;
}
```

---

## Implementation Checklist

- [x] Create `DROPS_IMPLEMENTATION.md` (this file)
- [x] Create `src/components/drops/GameCard.tsx`
- [x] Create `src/components/drops/GameDetailPanel.tsx`
- [x] Create `src/components/drops/DropsStatsTab.tsx`
- [x] Create `src/components/drops/DropsSettingsTab.tsx`
- [x] Refactor `src/components/DropsCenter.tsx`
- [x] Add CSS animations to `src/styles/globals.css`
- [ ] Test all functionality
- [ ] Verify responsive behavior
- [ ] Verify mining progress visibility

---

## Visual Reference

### Game Card States

```
┌─────────────────┐   ┌─────────────────┐   ┌─────────────────┐
│ [ACTIVE]        │   │ [MINING ⚡]     │   │ [CLAIM ✓]       │
│                 │   │                 │   │                 │
│   [Game Art]    │   │   [Game Art]    │   │   [Game Art]    │
│                 │   │                 │   │                 │
│ ───────────     │   │ ═══════════     │   │ ███████████     │
│ Game Name       │   │ Game Name       │   │ Game Name       │
│ 3 items         │   │ 45% ⛏️          │   │ Ready! 🎁       │
└─────────────────┘   └─────────────────┘   └─────────────────┘
   (hover state)        (mining shimmer)      (claim bounce)
```

### Detail Panel Layout

```
┌─────────────────────┐
│ [←] Game Name    [X]│
├─────────────────────┤
│ ┌─────────────────┐ │
│ │ Currently Mining│ │
│ │ █████████░░ 67% │ │
│ │ [Stop Mining]   │ │
│ └─────────────────┘ │
├─────────────────────┤
│ Active Campaigns    │
│ ┌─────────────────┐ │
│ │[img] Drop Name  │ │
│ │ ████░░░░ 23/45m │ │
│ │ [Start Mining]  │ │
│ └─────────────────┘ │
├─────────────────────┤
│ Your Collection     │
│ [🎁][🎁][🎁][🎁]   │
│                     │
└─────────────────────┘
```

---

## Notes

- Progress bars must always be visible when there's any progress > 0
- Shimmer animation indicates active mining
- The side panel should not push the grid content, it overlays
- Click outside panel or X button to close
- Tab navigation matches Home.tsx glass-button pattern
