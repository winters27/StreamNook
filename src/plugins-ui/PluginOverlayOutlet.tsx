// Renders ui-plugin overlay contributions at the app root. Each contributed
// component owns its own visibility, positioning, and animation; the outlet
// just keeps them mounted while their plugin is loaded.

import { usePluginUiRegistry } from './registry';

const PluginOverlayOutlet = () => {
  const overlays = usePluginUiRegistry((s) => s.overlays);
  return (
    <>
      {overlays.map((overlay) => (
        <overlay.Component key={`${overlay.pluginId}:${overlay.id}`} />
      ))}
    </>
  );
};

export default PluginOverlayOutlet;
