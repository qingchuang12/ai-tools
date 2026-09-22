import {shouldShowAds} from '../../../../shared/build-flags';
import {BUILD_FLAGS} from '../../build-flags';
import {useActivationStore} from '../../store/activationStore';

/**
 * 广告显隐判定 hook：复用激活状态（激活即广告消失——「激活版」是免费版1 的运行时状态）。
 * 总判据见 shared/build-flags.ts 的 shouldShowAds（仅免费版1 且未激活）。
 */
export function useAdsVisible(): boolean {
    const status = useActivationStore((s) => s.state?.status ?? 'inactive');
    return shouldShowAds(BUILD_FLAGS, status);
}
