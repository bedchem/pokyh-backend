import { ReactNode, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  Users,
  Building2,
  MonitorSmartphone,
  ScrollText,
  LogOut,
  Menu,
  X,
  Globe,
  UtensilsCrossed,
  Image,
  MessageCircle,
  FileText,
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
        `flex items-center gap-3 px-3 py-2.5 mx-2 text-sm font-medium transition-all duration-150 rounded-[10px] ${
          isActive ? '' : 'hover:bg-white/[0.05]'
        }`
      }
      style={({ isActive }) => ({
        background:    isActive ? 'rgba(10,132,255,0.14)' : undefined,
        color:         isActive ? '#0a84ff'               : 'rgba(235,235,245,0.55)',
        letterSpacing: '-0.01em',
      })}
    >
      <span className="w-[18px] h-[18px] flex-shrink-0 flex items-center justify-center opacity-90">
        {icon}
      </span>
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
      {/* Logo */}
      <div
        className="flex items-center gap-3 px-5 h-[60px] flex-shrink-0"
        style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}
      >
        <div
          className="w-7 h-7 rounded-[8px] flex items-center justify-center flex-shrink-0"
          style={{ background: 'rgba(10,132,255,0.18)', border: '1px solid rgba(10,132,255,0.28)' }}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <rect x="1" y="1" width="5.5" height="5.5" rx="1.5" fill="#0a84ff" opacity="0.9"/>
            <rect x="7.5" y="1" width="5.5" height="5.5" rx="1.5" fill="#0a84ff" opacity="0.7"/>
            <rect x="1" y="7.5" width="5.5" height="5.5" rx="1.5" fill="#0a84ff" opacity="0.7"/>
            <rect x="7.5" y="7.5" width="5.5" height="5.5" rx="1.5" fill="#0a84ff" opacity="0.9"/>
          </svg>
        </div>
        <div>
          <div className="text-[15px] font-semibold text-white tracking-[-0.02em] leading-none">Pokyh</div>
          <div className="text-[10px] mt-0.5 tracking-[0.02em] uppercase font-medium" style={{ color: 'rgba(235,235,245,0.3)' }}>
            Admin Panel
          </div>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 py-3 flex flex-col gap-0.5 overflow-y-auto scrollbar-thin">
        <div className="px-4 pb-1 pt-1">
          <span className="text-[10px] font-semibold uppercase tracking-[0.06em]" style={{ color: 'rgba(235,235,245,0.25)' }}>
            Overview
          </span>
        </div>
        <NavItem to="/dashboard"      icon={<LayoutDashboard size={16} />}   label="Dashboard"    onClick={onNavClick} />
        <NavItem to="/users"          icon={<Users size={16} />}             label="Users"        onClick={onNavClick} />
        <NavItem to="/classes"        icon={<Building2 size={16} />}         label="Classes"      onClick={onNavClick} />
        <NavItem to="/sessions"       icon={<MonitorSmartphone size={16} />} label="Sessions"     onClick={onNavClick} />

        <div className="px-4 pb-1 pt-3">
          <span className="text-[10px] font-semibold uppercase tracking-[0.06em]" style={{ color: 'rgba(235,235,245,0.25)' }}>
            Content
          </span>
        </div>
        <NavItem to="/dishes"         icon={<UtensilsCrossed size={16} />}   label="Speiseplan"   onClick={onNavClick} />
        <NavItem to="/comments"       icon={<MessageCircle size={16} />}     label="Kommentare"   onClick={onNavClick} />
        <NavItem to="/subject-images" icon={<Image size={16} />}             label="Fachbilder"   onClick={onNavClick} />

        <div className="px-4 pb-1 pt-3">
          <span className="text-[10px] font-semibold uppercase tracking-[0.06em]" style={{ color: 'rgba(235,235,245,0.25)' }}>
            System
          </span>
        </div>
        <NavItem to="/logs"           icon={<ScrollText size={16} />}        label="Logs"         onClick={onNavClick} />
        <NavItem to="/log-files"      icon={<FileText size={16} />}          label="Logdateien"   onClick={onNavClick} />
        <NavItem to="/tunnel"         icon={<Globe size={16} />}             label="Tunnel"       onClick={onNavClick} />
      </nav>

      {/* User */}
      <div className="p-3 flex-shrink-0" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
        <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-[10px]" style={{ background: 'rgba(255,255,255,0.04)' }}>
          <div
            className="w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-bold flex-shrink-0"
            style={{ background: 'rgba(10,132,255,0.22)', color: '#0a84ff' }}
          >
            {adminUser[0]?.toUpperCase() ?? 'A'}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[13px] font-medium truncate text-white">{adminUser}</div>
            <div className="text-[11px] truncate" style={{ color: 'rgba(235,235,245,0.3)' }}>Administrator</div>
          </div>
          <button
            onClick={onLogout}
            className="p-1.5 rounded-[8px] transition-colors flex-shrink-0"
            style={{ color: 'rgba(235,235,245,0.3)' }}
            title="Logout"
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#ff453a'; (e.currentTarget as HTMLElement).style.background = 'rgba(255,69,58,0.1)'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'rgba(235,235,245,0.3)'; (e.currentTarget as HTMLElement).style.background = ''; }}
          >
            <LogOut size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const { logout, username } = useAuth();
  const navigate = useNavigate();
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  function handleLogout() {
    logout();
    navigate('/login');
  }

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: '#000000' }}>
      {/* Desktop sidebar */}
      <aside
        className="hidden md:flex flex-col flex-shrink-0"
        style={{
          width: '248px',
          background: '#0d0d0d',
          borderRight: '1px solid rgba(255,255,255,0.07)',
        }}
      >
        <SidebarContent adminUser={username} onLogout={handleLogout} />
      </aside>

      {/* Mobile backdrop */}
      {isMobileMenuOpen && (
        <div
          className="fixed inset-0 z-40 md:hidden"
          style={{ background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}
          onClick={() => setIsMobileMenuOpen(false)}
        />
      )}

      {/* Mobile sidebar */}
      <aside
        className="fixed left-0 top-0 h-full z-50 md:hidden flex flex-col"
        style={{
          width: '280px',
          background: '#0d0d0d',
          borderRight: '1px solid rgba(255,255,255,0.07)',
          transform: isMobileMenuOpen ? 'translateX(0)' : 'translateX(-100%)',
          transition: 'transform 0.3s cubic-bezier(0.4,0,0.2,1)',
          boxShadow: isMobileMenuOpen ? '0 0 60px rgba(0,0,0,0.7)' : 'none',
        }}
      >
        <button
          className="absolute top-4 right-4 p-2 rounded-[10px]"
          style={{ color: 'rgba(235,235,245,0.4)', background: 'rgba(255,255,255,0.05)' }}
          onClick={() => setIsMobileMenuOpen(false)}
        >
          <X size={15} />
        </button>
        <SidebarContent adminUser={username} onLogout={handleLogout} onNavClick={() => setIsMobileMenuOpen(false)} />
      </aside>

      {/* Main */}
      <div className="flex-1 flex flex-col overflow-hidden min-w-0 min-h-0">
        {/* Mobile header */}
        <header
          className="flex md:hidden items-center justify-between px-4 flex-shrink-0"
          style={{
            height: '52px',
            background: 'rgba(13,13,13,0.92)',
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            borderBottom: '1px solid rgba(255,255,255,0.07)',
          }}
        >
          <button
            className="p-2 rounded-[10px]"
            style={{ color: 'rgba(235,235,245,0.5)', background: 'rgba(255,255,255,0.05)' }}
            onClick={() => setIsMobileMenuOpen(true)}
          >
            <Menu size={18} />
          </button>
          <div className="flex items-center gap-2">
            <div
              className="w-6 h-6 rounded-[7px] flex items-center justify-center"
              style={{ background: 'rgba(10,132,255,0.18)', border: '1px solid rgba(10,132,255,0.28)' }}
            >
              <svg width="11" height="11" viewBox="0 0 14 14" fill="none">
                <rect x="1" y="1" width="5.5" height="5.5" rx="1.5" fill="#0a84ff" opacity="0.9"/>
                <rect x="7.5" y="1" width="5.5" height="5.5" rx="1.5" fill="#0a84ff" opacity="0.7"/>
                <rect x="1" y="7.5" width="5.5" height="5.5" rx="1.5" fill="#0a84ff" opacity="0.7"/>
                <rect x="7.5" y="7.5" width="5.5" height="5.5" rx="1.5" fill="#0a84ff" opacity="0.9"/>
              </svg>
            </div>
            <span className="font-semibold text-[14px] text-white tracking-[-0.02em]">Pokyh</span>
          </div>
          <button
            onClick={handleLogout}
            className="p-2 rounded-[10px]"
            style={{ color: 'rgba(235,235,245,0.4)', background: 'rgba(255,255,255,0.05)' }}
            title="Logout"
          >
            <LogOut size={16} />
          </button>
        </header>

        <main
          className="flex-1 overflow-y-auto scroll-touch scrollbar-thin min-h-0"
          style={{ background: '#000000' }}
        >
          <div className="p-4 sm:p-6 md:p-8 max-w-[1380px] mx-auto">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
