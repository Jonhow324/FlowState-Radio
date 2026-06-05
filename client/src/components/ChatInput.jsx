import { useState } from 'react';
import api from '../services/api.js';
import useAppStore from '../stores/appStore.js';

function ChatInput() {
  const [message, setMessage] = useState('');
  const [isSending, setIsSending] = useState(false);
  const { playTrack, setDjMessage, refreshQueue } = useAppStore();

  const handleSend = async () => {
    if (!message.trim() || isSending) return;

    const msg = message.trim();
    setMessage('');
    setIsSending(true);

    try {
      const res = await api.post('/api/chat', { message: msg });
      const data = res.data;

      // Handle DJ talk
      if (data.say) {
        setDjMessage(data.say);
      }

      // Handle now playing (AI recommended a song)
      if (data.nowPlaying?.url) {
        const np = data.nowPlaying;
        playTrack(np.url, {
          trackId: np.trackId,
          trackName: np.trackName,
          artist: np.artist,
          albumArt: np.albumArt,
        });
      }

      // Handle search results (add to queue)
      if (data.action === 'search') {
        refreshQueue();
      }

      // Handle player control
      if (data.action === 'pause') {
        const audio = document.querySelector('audio') || null;
        // The audio is managed by the store, not DOM
      }

    } catch (error) {
      console.error('Failed to send message:', error);
    } finally {
      setIsSending(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="mx-6 mb-4">
      <div className="flex items-center gap-2 bg-white/5 rounded-full border border-white/10 px-4 py-2">
        <input
          type="text"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="跟 DJ 说点什么... 比如「来点适合下雨天的歌」"
          className="flex-1 bg-transparent text-sm text-white placeholder-white/30 outline-none"
          disabled={isSending}
        />
        <button
          onClick={handleSend}
          disabled={!message.trim() || isSending}
          className="p-2 text-claudio-400 hover:text-claudio-300 disabled:text-white/20 
                     disabled:cursor-not-allowed transition-colors"
        >
          {isSending ? (
            <div className="w-4 h-4 border-2 border-claudio-500 border-t-transparent rounded-full animate-spin" />
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}

export default ChatInput;
