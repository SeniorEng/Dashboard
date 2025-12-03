/**
 * CareConnect Design System Tokens
 * 
 * Centralized design tokens for consistent styling across the application.
 * Use these tokens instead of hardcoded values for colors, spacing, typography, etc.
 */

// ============================================
// TYPOGRAPHY SCALE
// ============================================

export const typography = {
  // Font families
  fontFamily: {
    sans: "'Outfit', sans-serif",
  },
  
  // Font sizes with line heights
  fontSize: {
    xs: { size: '0.75rem', lineHeight: '1rem' },      // 12px - Captions, timestamps
    sm: { size: '0.875rem', lineHeight: '1.25rem' },  // 14px - Secondary text, labels
    base: { size: '1rem', lineHeight: '1.5rem' },     // 16px - Body text
    lg: { size: '1.125rem', lineHeight: '1.75rem' },  // 18px - Subtitles
    xl: { size: '1.25rem', lineHeight: '1.75rem' },   // 20px - Card titles
    '2xl': { size: '1.5rem', lineHeight: '2rem' },    // 24px - Page titles
    '3xl': { size: '1.875rem', lineHeight: '2.25rem' }, // 30px - Hero headings
  },
  
  // Font weights
  fontWeight: {
    normal: '400',
    medium: '500',
    semibold: '600',
    bold: '700',
  },
} as const;

// ============================================
// SPACING SCALE (4px base grid)
// ============================================

export const spacing = {
  0: '0',
  0.5: '0.125rem',  // 2px
  1: '0.25rem',     // 4px
  1.5: '0.375rem',  // 6px
  2: '0.5rem',      // 8px
  2.5: '0.625rem',  // 10px
  3: '0.75rem',     // 12px
  3.5: '0.875rem',  // 14px
  4: '1rem',        // 16px
  5: '1.25rem',     // 20px
  6: '1.5rem',      // 24px
  7: '1.75rem',     // 28px
  8: '2rem',        // 32px
  9: '2.25rem',     // 36px
  10: '2.5rem',     // 40px
  12: '3rem',       // 48px
  14: '3.5rem',     // 56px
  16: '4rem',       // 64px
} as const;

// ============================================
// SEMANTIC SPACING TOKENS
// ============================================

export const semanticSpacing = {
  // Page layout
  pageInset: 'px-4',           // Horizontal page padding
  pageGap: 'space-y-6',        // Vertical gap between page sections
  
  // Card spacing
  cardPadding: 'p-4',          // Standard card padding
  cardPaddingLarge: 'p-6',     // Large card padding
  cardGap: 'space-y-4',        // Gap between card content
  
  // List items
  listGap: 'space-y-3',        // Gap between list items
  listItemPadding: 'p-4',      // Padding inside list items
  
  // Form elements
  formGap: 'space-y-4',        // Gap between form fields
  formSectionGap: 'space-y-6', // Gap between form sections
  
  // Inline elements
  inlineGap: 'gap-2',          // Small gap between inline elements
  inlineGapLarge: 'gap-4',     // Larger gap between inline elements
} as const;

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
    cardMuted: 'bg-white/80 backdrop-blur-sm',
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
// BORDER RADIUS
// ============================================

export const radius = {
  none: 'rounded-none',
  sm: 'rounded-sm',
  DEFAULT: 'rounded-md',
  md: 'rounded-md',
  lg: 'rounded-lg',
  xl: 'rounded-xl',
  '2xl': 'rounded-2xl',
  full: 'rounded-full',
} as const;

// ============================================
// SHADOWS
// ============================================

export const shadow = {
  none: 'shadow-none',
  sm: 'shadow-sm',
  DEFAULT: 'shadow',
  md: 'shadow-md',
  lg: 'shadow-lg',
  card: 'shadow-sm hover:shadow-md transition-shadow',
} as const;

// ============================================
// CONTAINER WIDTHS
// ============================================

export const containerWidth = {
  sm: 'max-w-sm',      // 384px - Modals, narrow forms
  md: 'max-w-md',      // 448px - Cards, forms
  lg: 'max-w-lg',      // 512px - Wide cards
  xl: 'max-w-xl',      // 576px - Content areas
  '2xl': 'max-w-2xl',  // 672px - Main content (mobile app)
  '3xl': 'max-w-3xl',  // 768px - Desktop content
  '4xl': 'max-w-4xl',  // 896px - Admin pages
  full: 'max-w-full',
} as const;

// ============================================
// COMPONENT STYLE PRESETS
// ============================================

export const componentStyles = {
  // Page container
  pageContainer: 'container mx-auto px-4 py-6',
  
  // Page header with back button
  pageHeader: 'flex items-center justify-between mb-6',
  pageTitle: 'text-2xl font-bold text-gray-900',
  pageSubtitle: 'text-sm text-gray-600',
  
  // Cards
  card: 'bg-white rounded-xl shadow-sm border border-gray-100',
  cardHover: 'bg-white rounded-xl shadow-sm border border-gray-100 hover:shadow-md transition-shadow cursor-pointer',
  cardMuted: 'bg-white/80 backdrop-blur-sm rounded-xl shadow-sm',
  
  // Lists
  listContainer: 'space-y-3',
  listItem: 'flex items-center justify-between p-4 rounded-xl bg-white shadow-sm',
  
  // Avatar/Icon containers
  avatarContainer: 'h-10 w-10 rounded-full flex items-center justify-center',
  avatarContainerSm: 'h-8 w-8 rounded-full flex items-center justify-center',
  avatarContainerLg: 'h-12 w-12 rounded-full flex items-center justify-center',
  
  // Buttons (semantic)
  btnPrimary: 'bg-teal-600 hover:bg-teal-700 text-white',
  btnSecondary: 'bg-white hover:bg-gray-50 text-gray-700 border border-gray-200',
  btnDanger: 'bg-red-600 hover:bg-red-700 text-white',
  btnGhost: 'hover:bg-gray-100 text-gray-700',
  
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
