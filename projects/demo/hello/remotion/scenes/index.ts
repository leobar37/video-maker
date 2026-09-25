/**
 * Scene registration: project code maps each scene `intent` to its renderer.
 * The kit dispatches through this registry (`SceneRenderer`).
 */
import { registerScene } from '../kit';

import { MediaScene } from './MediaScene';
import { TitleScene } from './TitleScene';

registerScene('title-motion', TitleScene);
registerScene('media-frame', MediaScene);
