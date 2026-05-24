import { useState, type ReactNode } from 'react';
import { Box, Collapse, IconButton, Paper, Typography } from '@mui/material';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import type { SxProps, Theme } from '@mui/material/styles';

interface CollapsibleLegendProps {
  /** Uppercase header text shown in the always-visible title bar. */
  title: string;
  /** Optional secondary line (e.g. the layer name) shown above the body. */
  subtitle?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  /** Extra styles merged onto the Paper (e.g. minWidth/maxWidth). */
  sx?: SxProps<Theme>;
}

/**
 * A map legend in a floating card whose body collapses to just its title bar.
 * `pointerEvents: 'auto'` so the toggle is clickable even when the parent
 * positioning Box opts out of pointer events to let map interaction through.
 */
export function CollapsibleLegend({
  title,
  subtitle,
  children,
  defaultOpen = true,
  sx,
}: CollapsibleLegendProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Paper
      elevation={4}
      sx={{
        pointerEvents: 'auto',
        bgcolor: 'rgba(255,255,255,0.96)',
        backdropFilter: 'blur(2px)',
        ...sx,
      }}
    >
      <Box
        onClick={() => setOpen((v) => !v)}
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 1,
          px: 1.5,
          py: 0.6,
          cursor: 'pointer',
        }}
      >
        <Typography
          variant="caption"
          sx={{ fontWeight: 700, letterSpacing: 0.15, textTransform: 'uppercase' }}
        >
          {title}
        </Typography>
        <IconButton size="small" sx={{ p: 0.2 }} aria-label={open ? 'Collapse legend' : 'Expand legend'}>
          {open ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
        </IconButton>
      </Box>
      <Collapse in={open}>
        <Box sx={{ px: 1.5, pb: 1.2 }}>
          {subtitle != null && (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.8 }}>
              {subtitle}
            </Typography>
          )}
          {children}
        </Box>
      </Collapse>
    </Paper>
  );
}
