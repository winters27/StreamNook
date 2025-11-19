import { useState, useEffect } from 'react';
import PenroseCanvas from './PenroseCanvas';

// Emote URLs for Twitch emotes (using static.twitchemotes.com)
const EMOTE_URLS: Record<string, string> = {
  'PogChamp': 'https://static-cdn.jtvnw.net/emoticons/v2/305954156/default/dark/1.0',
  'Kappa': 'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/1.0',
  'monkaS': 'https://cdn.7tv.app/emote/60420c7a77137b000de9e675/1x.webp',
  'KEKW': 'https://cdn.7tv.app/emote/60420c6977137b000de9e675/1x.webp',
  'Sadge': 'https://cdn.7tv.app/emote/60420c3577137b000de9e665/1x.webp',
  'Pepega': 'https://cdn.7tv.app/emote/60420c5677137b000de9e66a/1x.webp',
  'Copege': 'https://cdn.7tv.app/emote/60b8ff584e1b6d0e4c0e8a8f/1x.webp',
  'Aware': 'https://cdn.7tv.app/emote/60b8ff584e1b6d0e4c0e8a8e/1x.webp',
  'Clueless': 'https://cdn.7tv.app/emote/60b8ff584e1b6d0e4c0e8a8d/1x.webp',
  'forsenCD': 'https://cdn.7tv.app/emote/60420c7077137b000de9e673/1x.webp',
  '5Head': 'https://cdn.7tv.app/emote/60420c4577137b000de9e668/1x.webp',
  'BatChest': 'https://cdn.7tv.app/emote/60b8ff584e1b6d0e4c0e8a90/1x.webp',
};

// Messages with emote placeholders
const FUNNY_MESSAGES = [
  "Monkas levels rising...",
  "PogChamp energy detected...",
  "Sadge but loading...",
  "Pepega mode: ON",
  "KEKW intensifies...",
  "Copege in progress...",
  "Aware of the loading...",
  "Clueless about ETA...",
  "Surely it loads Clueless",
  "forsenCD picking a side...",
  "5Head calculations ongoing...",
  "Smoothbrain loading...",
  "Jebaited by the buffer...",
  "BatChest I HECKIN LOVE LOADING",
  "{monkaS} levels rising...",
  "{PogChamp} energy detected...",
  "{Sadge} but loading...",
  "{Pepega} mode: ON",
  "{KEKW} intensifies...",
  "{Copege} in progress...",
  "{Aware} of the loading...",
  "{Clueless} about ETA...",
  "Surely it loads {Clueless}",
  "{forsenCD} picking a side...",
  "{5Head} calculations ongoing...",
  "Smoothbrain loading...",
  "Jebaited by the buffer...",
  "{BatChest} I HECKIN LOVE LOADING",
  "Summoning the stream gods...",
  "Bribing the hamsters to run faster...",
  "Downloading more RAM...",
  "Asking chat for permission...",
  "Buffering the buffer...",
  "Warming up the pixels...",
  "Teaching the bits to dance...",
  "Convincing the packets to cooperate...",
  "Calibrating the pogometer...",
  "Inflating the bandwidth balloon...",
  "Waking up the stream gremlins...",
  "Consulting the Twitch elders...",
  "Charging the hype capacitors...",
  "Untangling the internet tubes...",
  "Sprinkling some magic emotes...",
  "Negotiating with the lag demons...",
  "Polishing the stream quality...",
  "Feeding the content machine...",
  "Activating turbo mode...",
  "The magic is coming...",
  "Reticulating splines...",
  "Compiling shaders for maximum Pog...",
  "Installing Adobe Reader...",
  "Deleting System32... just kidding!",
  "Asking Jeff if he's still there...",
  "Pressing F to pay respects...",
  "Calculating the meaning of Kappa...",
  "Dividing by zero... safely",
  "Reversing the polarity...",
  "Initializing the mainframe...",
  "Hacking the Gibson...",
  "Enhancing... ENHANCE!",
  "Spawning additional pylons...",
  "Constructing additional pylons...",
  "Preparing for unforeseen consequences...",
  "The cake is loading...",
  "Waking up Mr. Freeman...",
  "Catching them all...",
  "Praising the sun...",
  "Git gud... at loading",
  "Rolling for initiative...",
  "Checking for mimics...",
  "Preparing the ritual...",
  "Consulting the ancient texts...",
  "Summoning Exodia...",
  "Shuffling the deck...",
  "Drawing two cards...",
  "Activating my trap card...",
  "Powering up the Delorean...",
  "Reaching 88 mph...",
  "Reversing the tachyon flow...",
  "Adjusting the flux capacitor...",
  "Engaging warp drive...",
  "Making it so...",
  "Beaming up the data...",
  "Searching for intelligent life...",
  "Calculating hyperspace coordinates...",
  "Preparing the jump to lightspeed...",
  "Dodging blue shells...",
  "Collecting all 7 chaos emeralds...",
  "Spinning dash charging...",
  "Gotta go fast...",
  "Respecting the drip...",
  "Touching grass... virtually",
  "Ratio + L + no bitches...",
  "Based and loading-pilled...",
  "Copium levels: maximum",
  "Hopium reserves: full",
  "Checking the vibe...",
  "Manifesting good ping...",
  "No cap, this is loading fr fr",
  "Bussin' with the packets...",
  "Sheesh, almost there...",
  "Built different (loading)...",
  "It's giving... buffering",
  "Main character energy loading...",
  "Slay mode: activating",
  "Living rent free in your RAM...",
  "Tell me you're loading without...",
  "POV: You're waiting for auth...",
  "This you? (loading)",
  "Understood the assignment...",
  "Passing the vibe check...",
  "Clearing the chat logs...",
  "Banning the bots...",
  "Timing out the trolls...",
  "Raiding the server...",
  "Clipping that moment...",
  "Farming channel points...",
  "Claiming the drops...",
  "Subbing to the channel...",
  "Gifting subs to chat...",
  "Hyping the train...",
  "Popping the bits...",
  "Cheering with bits...",
  "Modding the chat...",
  "VIP status: pending...",
  "Lurking in style...",
  "Preparing the emote spam...",
  "Loading the copypasta...",
  "Monkas levels rising...",
  "PogChamp energy detected...",
  "Sadge but loading...",
  "Pepega mode: ON",
  "KEKW intensifies...",
  "Copege in progress...",
  "Aware of the loading...",
  "Clueless about ETA...",
  "Surely it loads Clueless",
  "forsenCD picking a side...",
  "5Head calculations ongoing...",
  "Smoothbrain loading...",
  "Jebaited by the buffer...",
  "BatChest I HECKIN LOVE LOADING",
  "Gigachad loading sequence...",
  "Soy facing at the progress...",
  "NPC dialogue loading...",
  "Touch grass? After this loads...",
];

interface LoadingWidgetProps {
  message?: string;
  useFunnyMessages?: boolean;
}

const LoadingWidget = ({ message, useFunnyMessages = false }: LoadingWidgetProps) => {
  const [currentMessageIndex, setCurrentMessageIndex] = useState(() => 
    Math.floor(Math.random() * FUNNY_MESSAGES.length)
  );

  useEffect(() => {
    if (!useFunnyMessages) return;

    const interval = setInterval(() => {
      // Pick a random message that's different from the current one
      setCurrentMessageIndex((prev) => {
        let newIndex;
        do {
          newIndex = Math.floor(Math.random() * FUNNY_MESSAGES.length);
        } while (newIndex === prev && FUNNY_MESSAGES.length > 1);
        return newIndex;
      });
    }, 10000); // Change message every 10 seconds

    return () => clearInterval(interval);
  }, [useFunnyMessages]);

  const displayMessage = useFunnyMessages 
    ? FUNNY_MESSAGES[currentMessageIndex]
    : message || "Loading stream...";

  // Parse message and replace emote placeholders with images
  const renderMessage = (msg: string) => {
    const parts: (string | JSX.Element)[] = [];
    let lastIndex = 0;
    const emoteRegex = /\{(\w+)\}/g;
    let match;

    while ((match = emoteRegex.exec(msg)) !== null) {
      // Add text before the emote
      if (match.index > lastIndex) {
        parts.push(msg.substring(lastIndex, match.index));
      }

      // Add the emote image
      const emoteName = match[1];
      const emoteUrl = EMOTE_URLS[emoteName];
      
      if (emoteUrl) {
        parts.push(
          <img
            key={`${emoteName}-${match.index}`}
            src={emoteUrl}
            alt={emoteName}
            className="inline-block w-6 h-6 mx-0.5 align-middle"
            title={emoteName}
          />
        );
      } else {
        // If emote URL not found, just show the name
        parts.push(emoteName);
      }

      lastIndex = match.index + match[0].length;
    }

    // Add remaining text
    if (lastIndex < msg.length) {
      parts.push(msg.substring(lastIndex));
    }

    return parts.length > 0 ? parts : msg;
  };

  return (
    <div className="absolute inset-0 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="flex flex-col items-center gap-6">
        {/* Use the canvas-based Penrose triangle animation */}
        <PenroseCanvas />

        <p className="text-textSecondary text-sm font-medium flex items-center">
          {useFunnyMessages ? renderMessage(displayMessage) : displayMessage}
        </p>
      </div>
    </div>
  );
};

export default LoadingWidget;
