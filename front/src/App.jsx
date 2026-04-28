import { Routes, Route } from 'react-router-dom'
import { AuthProvider } from './context/AuthContext'
import ProtectedRoute from './components/ProtectedRoute'
import Layout from './components/Layout'
import Login from './pages/Login'
import Home from './pages/Home'
import Chat from './pages/Chat'
import Projects from './pages/Projects'
import Docs from './pages/Docs'
import './App.css'

function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/" element={<ProtectedRoute><Layout /></ProtectedRoute>}>
          <Route index element={<Home />} />
          <Route path="chat" element={<Chat />} />
          <Route path="proyectos" element={<Projects />} />
          <Route path="docs" element={<Docs />} />
        </Route>
      </Routes>
    </AuthProvider>
  )
}

export default App
