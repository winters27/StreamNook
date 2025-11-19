import { useAppStore } from '../../stores/AppStore';
import { Info } from 'lucide-react';

const NotificationsSettings = () => {
  const { settings, updateSettings } = useAppStore();

  const liveNotifications = settings.live_notifications || {
    enabled: true,
    show_streamer_name: true,
    show_game_details: true,
    show_game_image: true,
    show_streamer_avatar: true,
  };

  const updateLiveNotifications = (updates: Partial<typeof liveNotifications>) => {
    updateSettings({
      ...settings,
      live_notifications: {
        ...liveNotifications,
        ...updates,
      },
    });
  };

  // Mock data for preview
  const mockStreamerName = 'xQc';
  const mockGameName = 'Grand Theft Auto V';
  const mockAvatarUrl = 'https://static-cdn.jtvnw.net/jtv_user_pictures/xqc-profile_image-9298dca608632101-70x70.jpeg';
  const mockGameImageUrl = 'https://static-cdn.jtvnw.net/ttv-boxart/32982_IGDB-285x380.jpg';

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-6">
        {/* Left Column - Settings */}
        <div className="space-y-4">
          {/* Enable Live Notifications */}
          <div>
            <div className="flex items-center justify-between">
              <div>
                <label className="block text-sm font-medium text-textPrimary">
                  Enable Notifications
                </label>
                <p className="text-xs text-textSecondary mt-1">
                  Get notified when followed streamers go live
                </p>
              </div>
              <button
                onClick={() => updateLiveNotifications({ enabled: !liveNotifications.enabled })}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                  liveNotifications.enabled ? 'bg-accent' : 'bg-gray-600'
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                    liveNotifications.enabled ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </button>
            </div>
          </div>

          {/* Notification Content Options */}
          {liveNotifications.enabled && (
            <>
              {/* Show Streamer Name */}
              <div className="flex items-center justify-between">
                <div>
                  <label className="text-sm text-textPrimary">Streamer Name</label>
                </div>
                <button
                  onClick={() =>
                    updateLiveNotifications({ show_streamer_name: !liveNotifications.show_streamer_name })
                  }
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                    liveNotifications.show_streamer_name ? 'bg-accent' : 'bg-gray-600'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      liveNotifications.show_streamer_name ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </div>

              {/* Show Game Details */}
              <div className="flex items-center justify-between">
                <div>
                  <label className="text-sm text-textPrimary">Game Details</label>
                </div>
                <button
                  onClick={() =>
                    updateLiveNotifications({ show_game_details: !liveNotifications.show_game_details })
                  }
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                    liveNotifications.show_game_details ? 'bg-accent' : 'bg-gray-600'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      liveNotifications.show_game_details ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </div>

              {/* Show Game Image */}
              <div className="flex items-center justify-between">
                <div>
                  <label className="text-sm text-textPrimary">Game Image</label>
                </div>
                <button
                  onClick={() =>
                    updateLiveNotifications({ show_game_image: !liveNotifications.show_game_image })
                  }
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                    liveNotifications.show_game_image ? 'bg-accent' : 'bg-gray-600'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      liveNotifications.show_game_image ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </div>

              {/* Show Streamer Avatar */}
              <div className="flex items-center justify-between">
                <div>
                  <label className="text-sm text-textPrimary">Streamer Avatar</label>
                </div>
                <button
                  onClick={() =>
                    updateLiveNotifications({
                      show_streamer_avatar: !liveNotifications.show_streamer_avatar,
                    })
                  }
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                    liveNotifications.show_streamer_avatar ? 'bg-accent' : 'bg-gray-600'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      liveNotifications.show_streamer_avatar ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </div>
            </>
          )}
        </div>

        {/* Right Column - Preview */}
        <div className="space-y-4">
          {/* Live Preview - Sticky */}
          <div className="glass-panel p-4 rounded-lg border border-accent/30 sticky top-0 w-fit">
            <div className="flex items-center gap-2 mb-3">
              <Info size={16} className="text-accent" />
              <span className="text-sm font-medium text-textPrimary">Live Preview</span>
            </div>
            
            <div className="glass-panel backdrop-blur-lg p-4 rounded-lg shadow-lg border border-accent/50 bg-accent/10 inline-block w-full">
              <div className="flex items-start gap-3">
                {/* Avatar */}
                {liveNotifications.show_streamer_avatar && (
                  <img
                    src={mockAvatarUrl}
                    alt="Streamer"
                    className="w-10 h-10 rounded-full flex-shrink-0"
                  />
                )}
                
                <div className="flex-shrink-0 min-w-[200px]">
                  {/* Main notification text */}
                  <div className="flex items-center gap-2 mb-1">
                    <Info size={20} className="text-accent flex-shrink-0" />
                    <span className="text-sm font-medium text-accent whitespace-normal">
                      {liveNotifications.show_streamer_name ? mockStreamerName : 'A streamer'} is now live!
                    </span>
                  </div>
                  
                  {/* Game details */}
                  {liveNotifications.show_game_details && (
                    <p className="text-xs text-textSecondary ml-7 whitespace-normal">
                      Playing {mockGameName}
                    </p>
                  )}
                </div>

                {/* Game image */}
                {liveNotifications.show_game_image && liveNotifications.show_game_details && (
                  <img
                    src={mockGameImageUrl}
                    alt="Game"
                    className="w-16 h-20 rounded object-cover flex-shrink-0"
                  />
                )}
              </div>
              
              {/* Action button */}
              <div className="mt-3 flex justify-end">
                <button className="px-3 py-1.5 bg-accent hover:bg-accent/80 text-white text-xs font-medium rounded transition-colors">
                  Watch
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Info Box - Below the grid */}
      <div className="glass-panel p-3 rounded-lg border border-accent/20">
        <div className="flex items-start gap-3">
          <div className="text-accent mt-0.5">
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
          </div>
          <div className="flex-1">
            <p className="text-xs text-textPrimary font-medium mb-1">
              About Notifications
            </p>
            <p className="text-xs text-textSecondary">
              Stream Nook checks for live streams every minute. Toggle options on the left to customize your notifications.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default NotificationsSettings;
