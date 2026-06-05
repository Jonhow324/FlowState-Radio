import Player from '../components/Player.jsx';
import DJMessage from '../components/DJMessage.jsx';
import ChatInput from '../components/ChatInput.jsx';
import TrackQueue from '../components/TrackQueue.jsx';
import useAppStore from '../stores/appStore.js';

function PlayerView() {
  const { djMessage } = useAppStore();

  return (
    <div>
      <Player />
      <DJMessage message={djMessage} />
      <TrackQueue />
      <ChatInput />
    </div>
  );
}

export default PlayerView;
