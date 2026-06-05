import { useState } from 'react';
import api from '../services/api.js';

function ChatInput() {
  const [message, setMessage] = useState('');
  const [isSending, setIsSending] = useState(false);

  const handleSend = async () => {
    if (!message.trim() || isSending) return;

    setIsSending(true);
    try {
      await api.post('/api/chat', { message: message.trim() });
      setMessage('');
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
          placeholder="跟 DJ 说点什么..."
          className="flex-1 bg-transparent text-sm text-white placeholder-white/30 outline-none"
          disabled={isSending}
        />
        <button
          onClick={handleSend}
          disabled={!message.trim() || isSending}
          className="p-2 text-claudio-400 hover:text-claudio-300 disabled:text-white/20 
                     disabled:cursor-not-allowed transition-colors"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
          </svg>
        </button>
      </div>
    </div>
  );
}

export default ChatInput;
