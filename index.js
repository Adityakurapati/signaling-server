const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);

// Render provides PORT environment variable
const PORT = process.env.PORT || 3000;

const io = new Server(server, {
  cors: {
    origin: "*", // Allow all origins for demo
    methods: ["GET", "POST"]
  },
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ['websocket', 'polling'] // Important for Render
});

// Health check endpoint for Render
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'OK', 
    onlineUsers: activeUsers.size,
    activeCalls: new Set(Array.from(userRooms.values())).size
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.send(`
    <h1>VoiceTranslate Signaling Server</h1>
    <p>Status: Running</p>
    <p>Online Users: ${activeUsers.size}</p>
    <p>Active Calls: ${new Set(Array.from(userRooms.values())).size}</p>
    <p>Socket Connections: ${io.engine.clientsCount}</p>
  `);
});

// Store active users
const activeUsers = new Map();
const userRooms = new Map();


io.on('connection', (socket) => {
  console.log('New connection:', socket.id);

  // User registration
  socket.on('register', (userData) => {
    const { userId, name, languages } = userData;
    
    activeUsers.set(userId, {
      socketId: socket.id,
      name,
      languages,
      status: 'available',
      lastSeen: Date.now()
    });
    
    socket.userId = userId;
    socket.join('online-users');
    
    // Notify all users about updated list
    broadcastUserList();
    console.log(`User registered: ${name} (${userId})`);
  });

  // Update user status
  socket.on('update-status', (status) => {
    if (socket.userId && activeUsers.has(socket.userId)) {
      activeUsers.get(socket.userId).status = status;
      broadcastUserList();
    }
  });

  // Initiate call
  socket.on('initiate-call', ({ targetUserId, offer, language }) => {
    const caller = activeUsers.get(socket.userId);
    const targetUser = activeUsers.get(targetUserId);
    
    if (!targetUser) {
      socket.emit('call-error', { message: 'User not available' });
      return;
    }

    // Create a unique room for this call
    const callId = `${socket.userId}-${targetUserId}-${Date.now()}`;
    userRooms.set(socket.userId, callId);
    userRooms.set(targetUserId, callId);
    
    // Update status
    activeUsers.get(socket.userId).status = 'in-call';
    activeUsers.get(targetUserId).status = 'in-call';
    broadcastUserList();
    
    // Send call request to target
    io.to(targetUser.socketId).emit('incoming-call', {
      callId,
      callerId: socket.userId,
      callerName: caller.name,
      offer,
      language,
      timestamp: Date.now()
    });
    
    socket.emit('call-initiated', { callId });
  });

  // Accept call
  socket.on('accept-call', ({ callId, answer }) => {
    const callParticipants = findCallParticipants(callId);
    
    if (callParticipants) {
      const { callerId } = callParticipants;
      const caller = activeUsers.get(callerId);
      
      io.to(caller.socketId).emit('call-accepted', {
        callId,
        answer,
        targetUserId: socket.userId
      });
      
      // Both users join the call room
      socket.join(callId);
      io.sockets.sockets.get(caller.socketId)?.join(callId);
    }
  });

  // Reject call
  socket.on('reject-call', ({ callId, reason }) => {
    const callParticipants = findCallParticipants(callId);
    
    if (callParticipants) {
      const { callerId } = callParticipants;
      const caller = activeUsers.get(callerId);
      
      io.to(caller.socketId).emit('call-rejected', {
        callId,
        reason,
        timestamp: Date.now()
      });
      
      // Clean up
      cleanupCall(callId);
    }
  });

  // WebRTC signaling
  socket.on('ice-candidate', ({ callId, candidate }) => {
    socket.to(callId).emit('ice-candidate', {
      candidate,
      senderId: socket.userId
    });
  });

  socket.on('end-call', ({ callId }) => {
    socket.to(callId).emit('call-ended', {
      callId,
      endedBy: socket.userId,
      timestamp: Date.now()
    });
    
    cleanupCall(callId);
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.userId);
    
    if (socket.userId) {
      // End any active calls
      const callId = userRooms.get(socket.userId);
      if (callId) {
        socket.to(callId).emit('call-ended', {
          callId,
          endedBy: 'system',
          reason: 'User disconnected',
          timestamp: Date.now()
        });
        cleanupCall(callId);
      }
      
      // Remove from active users
      activeUsers.delete(socket.userId);
      userRooms.delete(socket.userId);
      broadcastUserList();
    }
  });

  // Helper functions
  function broadcastUserList() {
    const usersArray = Array.from(activeUsers.entries()).map(([id, data]) => ({
      id,
      name: data.name,
      languages: data.languages,
      status: data.status,
      lastSeen: data.lastSeen
    }));
    
    io.to('online-users').emit('user-list-updated', usersArray);
  }

  function findCallParticipants(callId) {
    for (const [userId, roomId] of userRooms.entries()) {
      if (roomId === callId) {
        const otherUsers = Array.from(userRooms.entries())
          .filter(([uid, rid]) => rid === callId && uid !== userId);
        
        if (otherUsers.length > 0) {
          return { callerId: userId, targetId: otherUsers[0][0] };
        }
      }
    }
    return null;
  }

  function cleanupCall(callId) {
    // Update user statuses
    for (const [userId, roomId] of userRooms.entries()) {
      if (roomId === callId) {
        const user = activeUsers.get(userId);
        if (user) {
          user.status = 'available';
        }
        userRooms.delete(userId);
        
        // Leave room
        const userSocket = io.sockets.sockets.get(
          Array.from(io.sockets.sockets.values())
            .find(s => s.userId === userId)?.id
        );
        userSocket?.leave(callId);
      }
    }
    broadcastUserList();
  }
});

server.listen(PORT, () => {
  console.log(`Signaling server running on port ${PORT}`);
});

server.listen(PORT, () => {
  console.log(`✅ Signaling server running on port ${PORT}`);
  console.log(`📡 WebSocket URL: wss://your-app-name.onrender.com`);
  console.log(`🌐 HTTP URL: https://your-app-name.onrender.com`);
});