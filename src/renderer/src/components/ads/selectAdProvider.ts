import type {BuildFlags} from '../../../../shared/build-flags';
import {NoopAdProvider} from './NoopAdProvider';
import {OverwolfAdProvider} from './OverwolfAdProvider';
import {Union360AdProvider} from './Union360AdProvider';
import type {AdProvider} from './types';

/** 按 build flag 选渠道：免费版2 / 广告关闭一律 Noop 兜底，按 adRegion 分流海外/国内 */
export function selectAdProvider(flags: BuildFlags): AdProvider {
    if (!flags.adsEnabled) return new NoopAdProvider();
    return flags.adRegion === 'overseas' ? new OverwolfAdProvider() : new Union360AdProvider();
}
