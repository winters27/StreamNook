import { createContext } from 'react';

// Tier accent as "r, g, b" (for use in rgba(...)) to theme the whole profile
// view to a member's tier when shown in the public profile overlay. null = the
// normal self view in settings (neutral, untinted).
export const ProfileAccentContext = createContext<string | null>(null);

// true when the profile renders inside the compact public viewer overlay, so
// sections + tiles use tighter padding / smaller numbers than the wide settings
// pane. Default false (the settings self view keeps its roomier sizing).
export const ProfileCompactContext = createContext(false);

