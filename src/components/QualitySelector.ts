import videojs from 'video.js';

const MenuButton = videojs.getComponent('MenuButton');
const MenuItem = videojs.getComponent('MenuItem');

class QualityMenuItem extends MenuItem {
  private qualityLevel: any;
  private qualityIndex: number;

  constructor(player: any, options: any) {
    super(player, options);
    this.qualityLevel = options.qualityLevel;
    this.qualityIndex = options.qualityIndex;
    (this as any).selected(this.qualityLevel.enabled);
  }

  handleClick() {
    const superHandleClick = (MenuItem.prototype as any).handleClick;
    if (superHandleClick) {
      superHandleClick.call(this);
    }
    
    const qualityLevels = (this.player() as any).qualityLevels();
    
    // Disable all quality levels
    for (let i = 0; i < qualityLevels.length; i++) {
      qualityLevels[i].enabled = false;
    }
    
    // Enable the selected quality level
    this.qualityLevel.enabled = true;
  }
}

class QualityMenuButton extends MenuButton {
  constructor(player: any, options: any) {
    super(player, options);
    (this as any).controlText('Quality');
    
    // Update menu when quality levels change
    const qualityLevels = (player as any).qualityLevels();
    qualityLevels.on('addqualitylevel', () => {
      (this as any).update();
    });
    
    qualityLevels.on('change', () => {
      (this as any).update();
    });
    
    // Update menu when player is ready
    player.ready(() => {
      setTimeout(() => {
        (this as any).update();
      }, 1000);
    });
  }

  createEl() {
    const el = super.createEl();
    el.classList.add('vjs-quality-selector');
    return el;
  }

  buildCSSClass() {
    return `vjs-quality-menu-button ${super.buildCSSClass()}`;
  }

  createItems() {
    const items: any[] = [];
    const qualityLevels = ((this.player() as any).qualityLevels() as any);

    if (!qualityLevels || qualityLevels.length === 0) {
      return items;
    }

    // Add "Auto" option that enables all quality levels
    const autoItem = new MenuItem(this.player(), {
      label: 'Auto',
      selected: true,
      selectable: true,
    } as any);
    
    // Override the handleClick for Auto option
    (autoItem as any).handleClick = function() {
      const superHandleClick = (MenuItem.prototype as any).handleClick;
      if (superHandleClick) {
        superHandleClick.call(this);
      }
      
      // Enable all quality levels for auto mode
      for (let i = 0; i < qualityLevels.length; i++) {
        qualityLevels[i].enabled = true;
      }
    };
    
    items.push(autoItem);

    // Add quality level options
    for (let i = 0; i < qualityLevels.length; i++) {
      const qualityLevel = qualityLevels[i];
      const label = qualityLevel.height ? `${qualityLevel.height}p` : 
                    qualityLevel.bitrate ? `${Math.round(qualityLevel.bitrate / 1000)}kbps` : 
                    `Quality ${i + 1}`;
      
      items.push(new QualityMenuItem(this.player(), {
        label: label,
        qualityLevel: qualityLevel,
        qualityIndex: i,
        selectable: true,
      } as any));
    }

    return items;
  }
}

// Register the component with Video.js
videojs.registerComponent('QualityMenuButton', QualityMenuButton);

export default QualityMenuButton;
