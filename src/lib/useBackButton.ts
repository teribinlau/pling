import { useEffect, useRef } from 'react';
import { useStore } from './store';

type St = ReturnType<typeof useStore.getState>;

/** 现在叠着几层可以用返回键关掉的东西：提醒详情 / 讨论内容、选人、弹窗、看大图 */
function openLayers(st: St): number {
  const thread = st.view === 'discussions' && !!st.discussionId;
  return [st.mobileDetailOpen, thread, !!st.pendingComplete, st.showNew || !!st.discussionModal, !!st.viewer].filter(Boolean).length;
}

/** 关掉最上面那一层 */
function closeTop(st: St): void {
  if (st.viewer) st.closeViewer();
  else if (st.showNew) st.closeModal();
  else if (st.discussionModal) st.closeDiscussionModal();
  else if (st.pendingComplete) st.cancelPendingComplete();
  else if (st.view === 'discussions' && st.discussionId) st.openDiscussion(null);
  else st.select(null);
}

/**
 * 安卓（以及浏览器）的返回键：先关掉当前打开的那一层，而不是直接退出应用。
 *
 * 做法：打开了几层，历史里就压几条记录；返回键弹出一条 → popstate → 关掉最上面那层。
 * 用界面上的 × / 保存关掉层时，把多出来的记录也退掉（history.go），免得历史越积越多；
 * 这次退格引起的 popstate 要跳过，不然会把下面那层也关掉。
 * 只数层数、不管是哪一层：比如「新建讨论」保存后弹窗关掉、同时打开这个讨论，层数不变，历史也不用动。
 */
export function useBackButton(): void {
  const layers = useStore(openLayers);
  const depth = useRef(0); // 我们压进历史、还没退掉的记录条数
  const skipPop = useRef(0);

  useEffect(() => {
    const onPop = () => {
      if (skipPop.current > 0) {
        skipPop.current -= 1;
        return;
      }
      if (depth.current === 0) return; // 不是我们的记录（比如已经退到最底了）
      depth.current -= 1; // 浏览器已经弹掉了一条
      closeTop(useStore.getState());
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => {
    if (layers > depth.current) {
      for (let i = depth.current; i < layers; i++) window.history.pushState({ plingLayer: i + 1 }, '');
      depth.current = layers;
    } else if (layers < depth.current) {
      const n = depth.current - layers;
      depth.current = layers;
      skipPop.current += 1;
      window.history.go(-n);
    }
  }, [layers]);
}
