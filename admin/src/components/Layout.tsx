import { ReactNode, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  Users,
  Building2,
  MonitorSmartphone,
  ScrollText,
  Shield,
  LogOut,
  Menu,
  X,
  Globe,
} from 'lucide-react';
import { useAuth } from '../hooks/useAuth';

interface NavItemProps {
  to: string;
  icon: ReactNode;
  label: string;
  onClick?: () => void;
}

function NavItem({ to, icon, label, onClick }: NavItemProps) {
  return (
    <NavLink
      to={to}
      onClick={onClick}
      className={({ isActive }) =>
        [
          'flex items-center gap-3 py-2.5 mx-3 rounded-xl text-sm font-medium transition-all duration-150 relative',
          isActive ? '' : 'hover:text-[#f0f0f5]',
        ].join(' ')
      }
      style={({ isActive }) => ({
        background: isActive ? 'rgba(99,102,241,0.15)' : 'transparent',
        color: isActive ? '#818cf8' : '#8b8b9b',
        borderLeft: isActive ? '2px solid #6366f1' : '2px solid transparent',
        paddingLeft: '14px',
        paddingRight: '14px',
      })}
      onMouseEnter={(e) => {
        const el = e.currentTarget as HTMLAnchorElement;
        if (!el.getAttribute('aria-current')) {
          el.style.background = 'rgba(255,255,255,0.04)';
        }
      }}
      onMouseLeave={(e) => {
        const el = e.currentTarget as HTMLAnchorElement;
        if (!el.getAttribute('aria-current')) {
          el.style.background = 'transparent';
        }
      }}
    >
      <span className="w-[18px] h-[18px] flex-shrink-0 flex items-center justify-center">{icon}</span>
      <span>{label}</span>
    </NavLink>
  );
}

interface SidebarContentProps {
  adminUser: string;
  onLogout: () => void;
  onNavClick?: () => void;
}

function SidebarContent({ adminUser, onLogout, onNavClick }: SidebarContentProps) {
  return (
    <div className="flex flex-col h-full">
      <div
        className="flex items-center gap-3 px-5 h-16 flex-shrink-0"
        style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}
      >
        <div
          className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
          style={{ background: 'rgba(99,102,241,0.2)', border: '1px solid rgba(99,102,241,0.25)' }}
        >
          <Shield size={16} style={{ color: '#818cf8' }} />
        </div>
        <span className="text-[#f0f0f5] font-bold text-base tracking-tight">Pokyh</span>
      </div>

      <nav className="flex-1 py-4 flex flex-col gap-0.5 overflow-y-auto">
        <NavItem to="/dashboard" icon={<LayoutDashboard size={17} />} label="Dashboard" onClick={onNavClick} />
        <NavItem to="/users" icon={<Users size={17} />} label="Users" onClick={onNavClick} />
        <NavItem to="/classes" icon={<Building2 size={17} />} label="Classes" onClick={onNavClick} />
        <NavItem to="/sessions" icon={<MonitorSmartphone size={17} />} label="Sessions" onClick={onNavClick} />
        <NavItem to="/logs" icon={<ScrollText size={17} />} label="Logs" onClick={onNavClick} />
        <NavItem to="/tunnel" icon={<Globe size={17} />} label="Tunnel" onClick={onNavClick} />
      </nav>

      <div
        className="p-3 flex-shrink-0"
        style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}
      >
        <div
          className="flex items-center gap-3 px-3 py-2.5 rounded-xl"
          style={{ background: 'rgba(255,255,255,0.03)' }}
        >
          <div
            className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0"
            style={{ background: 'rgba(99,102,241,0.25)', color: '#818cf8' }}
          >
            {adminUser[0]?.toUpperCase() ?? 'A'}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium truncate" style={{ color: '#f0f0f5' }}>{adminUser}</div>
            <div className="text-xs" style={{ color: '#4a4a5e' }}>Administrator</div>
          </div>
          <button
            onClick={onLogout}
            className="p-1.5 rounded-lg transition-colors flex-shrink-0"
            style={{ color: '#4a4a5e' }}
            title="Logout"
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#ff453a'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#4a4a5e'; }}
          >
            <LogOut size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}

interface LayoutProps {
  children: ReactNode;
}

export function Layout({ children }: LayoutProps) {
  const { logout, username } = useAuth();
  const navigate = useNavigate();
  const adminUser = username;
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  function handleLogout() {
    logout();
    navigate('/login');
  }

  function closeMobileMenu() {
    setIsMobileMenuOpen(false);
  }

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: '#08080f' }}>
      <aside
        className="hidden md:flex flex-col flex-shrink-0"
        style={{
          width: '240px',
          background: '#111116',
          borderRight: '1px solid rgba(255,255,255,0.07)',
        }}
      >
        <SidebarContent adminUser={adminUser} onLogout={handleLogout} />
      </aside>

      {isMobileMenuOpen && (
        <div
          className="fixed inset-0 z-40 md:hidden"
          style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)' }}
          onClick={closeMobileMenu}
        />
      )}

      <aside
        className="fixed left-0 top-0 h-full z-50 md:hidden"
        style={{
          width: '280px',
          background: '#111116',
          borderRight: '1px solid rgba(255,255,255,0.07)',
          transform: isMobileMenuOpen ? 'translateX(0)' : 'translateX(-100%)',
          transition: 'transform 0.28s cubic-bezier(0.4,0,0.2,1)',
          boxShadow: isMobileMenuOpen ? '0 0 60px rgba(0,0,0,0.6)' : 'none',
        }}
      >
        <button
          className="absolute top-4 right-4 p-2 rounded-lg transition-colors"
          style={{ color: '#8b8b9b', background: 'rgba(255,255,255,0.05)' }}
          onClick={closeMobileMenu}
        >
          <X size={16} />
        </button>
        <SidebarContent adminUser={adminUser} onLogout={handleLogout} onNavClick={closeMobileMenu} />
      </aside>

      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        <header
          className="flex md:hidden items-center justify-between px-4 flex-shrink-0"
          style={{
            height: '56px',
            background: '#111116',
            borderBottom: '1px solid rgba(255,255,255,0.07)',
          }}
        >
          <button
            className="p-2 rounded-lg transition-colors"
            style={{ color: '#8b8b9b', background: 'rgba(255,255,255,0.05)' }}
            onClick={() => setIsMobileMenuOpen(true)}
          >
            <Menu size={19} />
          </button>
          <div className="flex items-center gap-2">
            <div
              className="w-7 h-7 rounded-lg flex items-center justify-center"
              style={{ background: 'rgba(99,102,241,0.2)', border: '1px solid rgba(99,102,241,0.25)' }}
            >
              <Shield size={14} style={{ color: '#818cf8' }} />
            </div>
            <span className="font-bold text-sm" style={{ color: '#f0f0f5' }}>Pokyh</span>
          </div>
          <button
            onClick={handleLogout}
            className="p-2 rounded-lg transition-colors"
            style={{ color: '#4a4a5e', background: 'rgba(255,255,255,0.05)' }}
            title="Logout"
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#ff453a'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#4a4a5e'; }}
          >
            <LogOut size={17} />
          </button>
        </header>

        <main className="flex-1 overflow-y-auto" style={{ background: '#08080f' }}>
          <div className="p-5 md:p-8 max-w-[1400px] mx-auto">{children}</div>
        </main>
      </div>
    </div>
  );
}
