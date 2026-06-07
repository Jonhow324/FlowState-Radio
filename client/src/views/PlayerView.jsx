import { motion } from 'framer-motion';
import Player from '../components/Player.jsx';
import SearchBar from '../components/SearchBar.jsx';
import DJMessage from '../components/DJMessage.jsx';
import ChatInput from '../components/ChatInput.jsx';
import TrackQueue from '../components/TrackQueue.jsx';
import useAppStore from '../stores/appStore.js';

const stagger = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.08 } },
};

const fadeUp = {
  hidden: { opacity: 0, y: 12 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.3, ease: 'easeOut' } },
};

function PlayerView() {
  const { djMessage } = useAppStore();

  return (
    <motion.div variants={stagger} initial="hidden" animate="visible">
      <motion.div variants={fadeUp}>
        <SearchBar />
      </motion.div>
      <motion.div variants={fadeUp}>
        <Player />
      </motion.div>
      <motion.div variants={fadeUp}>
        <DJMessage message={djMessage} />
      </motion.div>
      <motion.div variants={fadeUp}>
        <TrackQueue />
      </motion.div>
      <motion.div variants={fadeUp}>
        <ChatInput />
      </motion.div>
    </motion.div>
  );
}

export default PlayerView;
