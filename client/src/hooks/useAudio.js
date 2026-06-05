import { useRef, useCallback } from 'react';

function useAudio() {
  const audioRef = useRef(null);

  const getAudio = useCallback(() => {
    if (!audioRef.current) {
      audioRef.current = new Audio();
    }
    return audioRef.current;
  }, []);

  const play = useCallback(
    (url) => {
      const audio = getAudio();
      if (url) audio.src = url;
      audio.play().catch(console.error);
    },
    [getAudio]
  );

  const pause = useCallback(() => {
    getAudio().pause();
  }, [getAudio]);

  const stop = useCallback(() => {
    const audio = getAudio();
    audio.pause();
    audio.currentTime = 0;
  }, [getAudio]);

  const setVolume = useCallback(
    (vol) => {
      getAudio().volume = Math.max(0, Math.min(1, vol));
    },
    [getAudio]
  );

  return { play, pause, stop, setVolume, getAudio };
}

export default useAudio;
