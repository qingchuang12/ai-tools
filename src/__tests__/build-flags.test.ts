import {describe, expect, it} from 'vitest';
import {cloudSyncHardDisabled, resolveBuildFlags, shouldShowAds} from '../shared/build-flags';
import {selectAdProvider} from '../renderer/src/components/ads/selectAdProvider';

/** build flag 归一化与显隐判据（免费版1/2 × 地区 × 激活状态组合矩阵） */
describe('resolveBuildFlags', () => {
    it('空输入回退默认（free1-cn 全功能，等同历史行为）', () => {
        expect(resolveBuildFlags(null)).toEqual({
            edition: 'free1', adRegion: 'cn', adsEnabled: true,
            cloudSyncEnabled: true, cloudSyncActivationUnlocks: true,
        });
        expect(resolveBuildFlags({})).toEqual(resolveBuildFlags(null));
    });

    it('free2：无广告（显式开启也压掉）+ 云同步默认关 + 激活可解锁', () => {
        const f = resolveBuildFlags({edition: 'free2'});
        expect(f.adsEnabled).toBe(false);
        expect(f.cloudSyncEnabled).toBe(false);
        expect(f.cloudSyncActivationUnlocks).toBe(true);
        expect(cloudSyncHardDisabled(f)).toBe(false);

        expect(resolveBuildFlags({edition: 'free2', adsEnabled: '1'}).adsEnabled).toBe(false);
    });

    it('free2 硬砍模式：cloudSyncActivationUnlocks=false 时云同步对激活用户也关闭', () => {
        const f = resolveBuildFlags({edition: 'free2', cloudSyncActivationUnlocks: '0'});
        expect(cloudSyncHardDisabled(f)).toBe(true);
    });

    it('free2 云同步可显式开回（软模式组合）', () => {
        expect(resolveBuildFlags({edition: 'free2', cloudSyncEnabled: '1'}).cloudSyncEnabled).toBe(true);
    });

    it('非法枚举回退默认，不出半残产物', () => {
        expect(resolveBuildFlags({edition: 'free3', adRegion: 'jp'}).edition).toBe('free1');
        expect(resolveBuildFlags({edition: 'free3', adRegion: 'jp'}).adRegion).toBe('cn');
    });

    it('布尔字面量归一：1/true 为真，0/false/空串为缺省', () => {
        expect(resolveBuildFlags({adsEnabled: '1'}).adsEnabled).toBe(true);
        expect(resolveBuildFlags({adsEnabled: true}).adsEnabled).toBe(true);
        expect(resolveBuildFlags({adsEnabled: '0'}).adsEnabled).toBe(false);
        expect(resolveBuildFlags({adsEnabled: 'false'}).adsEnabled).toBe(false);
        expect(resolveBuildFlags({adsEnabled: ''}).adsEnabled).toBe(true);
        expect(resolveBuildFlags({cloudSyncEnabled: ''}).cloudSyncEnabled).toBe(true);
    });
});

describe('shouldShowAds（广告显隐总判据）', () => {
    it('free1：仅 inactive 看广告，trial/activated 消失', () => {
        const free1 = resolveBuildFlags({edition: 'free1'});
        expect(shouldShowAds(free1, 'inactive')).toBe(true);
        expect(shouldShowAds(free1, 'trial')).toBe(false);
        expect(shouldShowAds(free1, 'activated')).toBe(false);
    });

    it('free2 任何状态都不出广告', () => {
        const free2 = resolveBuildFlags({edition: 'free2'});
        expect(shouldShowAds(free2, 'inactive')).toBe(false);
        expect(shouldShowAds(free2, 'activated')).toBe(false);
    });

    it('free1 但显式关广告时不出', () => {
        const f = resolveBuildFlags({edition: 'free1', adsEnabled: '0'});
        expect(shouldShowAds(f, 'inactive')).toBe(false);
    });
});

describe('selectAdProvider（按地区选渠道）', () => {
    it('overseas → Overwolf；cn → Union360；广告关闭/免费版2 → Noop', () => {
        expect(selectAdProvider(resolveBuildFlags({edition: 'free1', adRegion: 'overseas'})).name).toBe('overwolf');
        expect(selectAdProvider(resolveBuildFlags({edition: 'free1', adRegion: 'cn'})).name).toBe('union360');
        expect(selectAdProvider(resolveBuildFlags({edition: 'free2'})).name).toBe('noop');
        expect(selectAdProvider(resolveBuildFlags({edition: 'free1', adsEnabled: '0'})).name).toBe('noop');
    });

    it('占位/无 DOM 渠道 init 恒不填充（node 环境无 document）', async () => {
        const noop = selectAdProvider(resolveBuildFlags({edition: 'free2'}));
        await expect(noop.init({} as HTMLElement)).resolves.toBe(false);
        const cn = selectAdProvider(resolveBuildFlags({edition: 'free1', adRegion: 'cn'}));
        await expect(cn.init({} as HTMLElement)).resolves.toBe(false);
    });
});
