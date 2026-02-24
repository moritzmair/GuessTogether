import { io } from 'socket.io-client';

// Proxy via Vite leitet /socket.io weiter an :3001
const socket = io({ autoConnect: true });

export default socket;
