import {useEffect, useRef, useState} from 'react';
import {BUILD_FLAGS} from '../../build-flags';
import {selectAdProvider} from './selectAdProvider';
import type {AdSlotSize} from './types';
import {useAdsVisible} from './useAdsVisible';

const SLOT_DIMENSIONS: Record<AdSlotSize, {width: number; height: number}> = {
    '728x90': {width: 728, height: 90},
    '300x250': {width: 300, height: 250},
    '160x600': {width: 160, height: 600},
    '300x600': {width: 300, height: 600},
    '970x250': {width: 970, height: 250},
};

/**
 * 广告位容器：仅「免费版1 且未激活」渲染（激活即消失，广告随权益走）。
 * 渠道由 build flag 决定；init 失败/未填充（渠道不可用、未开通）时容器收起为 0 高，
 * 不影响主功能。挂载点由页面布局决定。
 */
export default function AdSlot({size = '728x90'}: {size?: AdSlotSize}) {
    const visible = useAdsVisible();
    const containerRef = useRef<HTMLDivElement>(null);
    const [filled, setFilled] = useState(false);

    useEffect(() => {
        if (!visible || !containerRef.current) return;
        const provider = selectAdProvider(BUILD_FLAGS);
        let cancelled = false;
        provider
            .init(containerRef.current)
            .then((ok) => {
                if (!cancelled) setFilled(ok);
            })
            .catch(() => {
                if (!cancelled) setFilled(false);
            });
        return () => {
            cancelled = true;
            provider.destroy();
        };
    }, [visible]);

    if (!visible) return null;
    const dim = SLOT_DIMENSIONS[size];
    return (
        <div
            ref={containerRef}
            aria-hidden
            style={{width: dim.width, height: filled ? dim.height : 0, overflow: 'hidden', margin: '0 auto'}}
        />
    );
}
