/**
 * CareConnect Design System Tokens
 * 
 * Centralized design tokens for consistent styling across the application.
 * Use these tokens instead of hardcoded values for colors, spacing, typography, etc.
 */

// ============================================
// COLOR TOKENS (Semantic)
// ============================================

export const colors = {
  // Primary brand colors
  primary: {
    DEFAULT: 'bg-teal-600',
    hover: 'hover:bg-teal-700',
    light: 'bg-teal-50',
    text: 'text-teal-600',
    textLight: 'text-teal-700',
    border: 'border-teal-200',
  },
  
  // Status colors
  status: {
    scheduled: {
      bg: 'bg-blue-50',
      text: 'text-blue-700',
      border: 'border-blue-200',
      icon: 'text-blue-500',
    },
    inProgress: {
      bg: 'bg-amber-50',
      text: 'text-amber-700',
      border: 'border-amber-200',
      icon: 'text-amber-500',
    },
    documenting: {
      bg: 'bg-orange-50',
      text: 'text-orange-700',
      border: 'border-orange-200',
      icon: 'text-orange-500',
    },
    completed: {
      bg: 'bg-green-50',
      text: 'text-green-700',
      border: 'border-green-200',
      icon: 'text-green-500',
    },
    cancelled: {
      bg: 'bg-gray-50',
      text: 'text-gray-600',
      border: 'border-gray-200',
      icon: 'text-gray-400',
    },
  },
  
  // Service type colors
  service: {
    hauswirtschaft: {
      bg: 'bg-emerald-500',
      bgLight: 'bg-emerald-50',
      text: 'text-emerald-700',
      border: 'border-emerald-200',
    },
    alltagsbegleitung: {
      bg: 'bg-sky-500',
      bgLight: 'bg-sky-50',
      text: 'text-sky-700',
      border: 'border-sky-200',
    },
    erstberatung: {
      bg: 'bg-purple-500',
      bgLight: 'bg-purple-50',
      text: 'text-purple-700',
      border: 'border-purple-200',
    },
  },
  
  // Pflegegrad colors
  pflegegrad: {
    0: { bg: 'bg-gray-50', text: 'text-gray-600', border: 'border-gray-200' },
    1: { bg: 'bg-green-50', text: 'text-green-700', border: 'border-green-200' },
    2: { bg: 'bg-blue-50', text: 'text-blue-700', border: 'border-blue-200' },
    3: { bg: 'bg-amber-50', text: 'text-amber-700', border: 'border-amber-200' },
    4: { bg: 'bg-orange-50', text: 'text-orange-700', border: 'border-orange-200' },
    5: { bg: 'bg-red-50', text: 'text-red-700', border: 'border-red-200' },
  },
  
  badge: {
    green: { bg: 'bg-green-50', text: 'text-green-700', border: 'border-green-200' },
    amber: { bg: 'bg-amber-50', text: 'text-amber-700', border: 'border-amber-200' },
    blue: { bg: 'bg-blue-50', text: 'text-blue-700', border: 'border-blue-200' },
    red: { bg: 'bg-red-50', text: 'text-red-700', border: 'border-red-200' },
    gray: { bg: 'bg-gray-100', text: 'text-gray-600', border: 'border-gray-200' },
    teal: { bg: 'bg-teal-50', text: 'text-teal-700', border: 'border-teal-200' },
    purple: { bg: 'bg-purple-50', text: 'text-purple-700', border: 'border-purple-200' },
    orange: { bg: 'bg-orange-50', text: 'text-orange-700', border: 'border-orange-200' },
    emerald: { bg: 'bg-emerald-50', text: 'text-emerald-700', border: 'border-emerald-200' },
    rose: { bg: 'bg-rose-50', text: 'text-rose-700', border: 'border-rose-200' },
  },

  // Feedback colors
  feedback: {
    success: { bg: 'bg-green-50', text: 'text-green-800', border: 'border-green-200' },
    warning: { bg: 'bg-amber-50', text: 'text-amber-800', border: 'border-amber-200' },
    error: { bg: 'bg-red-50', text: 'text-red-800', border: 'border-red-200' },
    info: { bg: 'bg-blue-50', text: 'text-blue-800', border: 'border-blue-200' },
  },
  
  // Neutral/surface colors
  surface: {
    page: 'bg-gradient-to-br from-[#f5e6d3] to-[#e8d4c4]', // Warm beige gradient
    card: 'bg-white',
    cardMuted: 'bg-white',
    cardTinted: 'bg-gray-50',
  },
} as const;

// ============================================
// ICON SIZES
// ============================================

export const iconSize = {
  xs: 'h-3 w-3',    // 12px - Inline with small text
  sm: 'h-4 w-4',    // 16px - Standard inline icons
  md: 'h-5 w-5',    // 20px - Buttons, list items
  lg: 'h-6 w-6',    // 24px - Cards, headers
  xl: 'h-8 w-8',    // 32px - Empty states
  '2xl': 'h-12 w-12', // 48px - Hero icons
} as const;

// ============================================
// LAYOUT VARIANTS
// ============================================

export type LayoutVariant = 'default' | 'admin' | 'wide' | 'narrow' | 'full';

export const layoutVariants: Record<LayoutVariant, string> = {
  default: 'max-w-2xl',
  narrow: 'max-w-xl',
  admin: 'max-w-4xl',
  wide: 'max-w-6xl',
  full: 'max-w-full',
} as const;

// ============================================
// COMPONENT STYLE PRESETS
// ============================================

export const componentStyles = {
  pageContainer: 'container mx-auto px-4 py-6',
  
  pageHeader: 'flex flex-col gap-3 mb-6 sm:flex-row sm:items-center sm:justify-between',
  pageHeaderTop: 'flex items-center gap-3',
  pageHeaderTitleWrap: 'flex-1 min-w-0',
  pageTitle: 'text-xl sm:text-2xl font-bold text-gray-900',
  pageSubtitle: 'text-sm text-gray-600 mt-0.5',
  pageHeaderBadges: 'flex flex-wrap items-center gap-2 mt-1',
  pageHeaderActions: 'flex flex-col gap-2 w-full sm:flex-row sm:w-auto sm:items-center',
  pageHeaderActionBtn: 'w-full sm:w-auto',
  
  // Cards (verwende Standard-Card-Komponente, keine custom bg/border)
  card: '',
  cardHover: 'cursor-pointer',
  cardMuted: 'bg-white rounded-xl shadow-sm',
  
  // Lists (flex gap statt space-y, damit Links korrekt dargestellt werden)
  listContainer: 'flex flex-col gap-3',
  listItem: 'flex items-center justify-between p-4 rounded-xl bg-white shadow-sm',
  
  // Buttons (semantic)
  btnPrimary: 'bg-teal-600 hover:bg-teal-700 text-white',
  btnSecondary: 'bg-white hover:bg-gray-50 text-gray-700 border border-gray-200',
  btnDanger: 'bg-red-600 hover:bg-red-700 text-white',
  btnGhost: 'hover:bg-gray-100 text-gray-700',
  
  // Responsive tabs (priority+ pattern)
  tabsList: 'bg-white h-auto p-1 flex-wrap gap-1',
  tabsTrigger: 'text-sm',
  tabsOverflowBtn: 'h-8 px-3 text-sm font-medium',
  tabsOverflowActive: 'bg-teal-100 text-teal-700',
  tabsOverflowInactive: 'text-gray-600 hover:text-gray-900 hover:bg-gray-100',
  
  // Form sections
  formSection: 'space-y-4 border-t pt-4',
  formSectionTitle: 'font-medium text-gray-900 flex items-center gap-2',
  
  // Empty states
  emptyState: 'flex flex-col items-center justify-center py-12 text-center',
  emptyStateIcon: 'h-12 w-12 text-gray-300 mb-4',
  emptyStateTitle: 'text-lg font-medium text-gray-900 mb-2',
  emptyStateText: 'text-gray-600 mb-4',
} as const;

// ============================================
// TYPE DEFINITIONS
// ============================================

export type StatusColorSet = {
  bg: string;
  text: string;
  border: string;
  icon: string;
};

export type ServiceColorSet = {
  bg: string;
  bgLight: string;
  text: string;
  border: string;
};

export type PflegegradColorSet = {
  bg: string;
  text: string;
  border: string;
};

// ============================================
// UTILITY FUNCTIONS
// ============================================

/**
 * Get status color classes
 */
export function getStatusColors(status: string): StatusColorSet {
  const statusMap: Record<string, StatusColorSet> = {
    scheduled: colors.status.scheduled,
    'in-progress': colors.status.inProgress,
    documenting: colors.status.documenting,
    completed: colors.status.completed,
    cancelled: colors.status.cancelled,
  };
  return statusMap[status] || colors.status.scheduled;
}

/**
 * Get service type color classes
 */
export function getServiceColors(serviceType: string): ServiceColorSet {
  const serviceMap: Record<string, ServiceColorSet> = {
    hauswirtschaft: colors.service.hauswirtschaft,
    alltagsbegleitung: colors.service.alltagsbegleitung,
    erstberatung: colors.service.erstberatung,
  };
  return serviceMap[serviceType] || colors.service.hauswirtschaft;
}

/**
 * Get Pflegegrad color classes
 */
export function getPflegegradColors(pflegegrad: number): PflegegradColorSet {
  const pg = Math.min(Math.max(pflegegrad, 0), 5);
  return colors.pflegegrad[pg as keyof typeof colors.pflegegrad];
}
