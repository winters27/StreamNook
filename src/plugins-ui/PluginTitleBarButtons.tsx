// Renders ui-plugin title bar buttons in the native action-cluster style.
// Each contribution gets its own component instance so its optional
// useIsActive hook runs under the rules of hooks.

import { Tooltip } from '../components/ui/Tooltip';
import { usePluginUiRegistry } from './registry';
import type { TitleBarButtonContribution } from './types';

const PluginTitleBarButton = ({
  contribution,
}: {
  contribution: TitleBarButtonContribution;
}) => {
  const useIsActive = contribution.useIsActive ?? (() => false);
  const useIsVisible = contribution.useIsVisible ?? (() => true);
  const isActive = useIsActive();
  const isVisible = useIsVisible();
  if (!isVisible) return null;
  return (
    <Tooltip content={contribution.tooltip} delay={200}>
      <button
        onClick={contribution.onClick}
        className={`p-1.5 rounded transition-all duration-200 ${
          isActive ? 'text-accent' : 'text-textSecondary hover:text-textPrimary'
        }`}
      >
        <contribution.Icon size={16} />
      </button>
    </Tooltip>
  );
};

const PluginTitleBarButtons = () => {
  const buttons = usePluginUiRegistry((s) => s.titleBarButtons);
  return (
    <>
      {buttons.map((button) => (
        <PluginTitleBarButton
          key={`${button.pluginId}:${button.id}`}
          contribution={button}
        />
      ))}
    </>
  );
};

export default PluginTitleBarButtons;
