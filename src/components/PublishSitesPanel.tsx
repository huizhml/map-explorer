import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Autocomplete,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Fab,
  List,
  ListItem,
  ListItemText,
  Snackbar,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import PublishIcon from '@mui/icons-material/Publish';
import { apiUrl } from '../utils/apiBase';
import { listSavedFeatures, listSavedFeatureTags, type SavedFeature } from '../services/savedFeaturesApi';

/**
 * Choose which saved features appear as showcase sites on the public map.
 *
 * The selection is made here — where the sites are authored and can be
 * recognised by name — while the publishing itself is a repo command
 * (`npm run sites:publish`). That split is deliberate: the published bundle is
 * committed to the frontend repo so it travels with the code, and a browser
 * cannot write to a checkout. What this panel does is let you confirm exactly
 * what a given tag will publish before running it, and hand you the command.
 *
 * Mounted as a floating overlay from App.tsx rather than inside Sidebar, to
 * keep it independent of that component's layout.
 */

const DEFAULT_TAG = 'showcase';

function tagsOf(feature: SavedFeature): string[] {
  return feature.metadata?.tags ?? [];
}

export function PublishSitesPanel() {
  const [open, setOpen] = useState(false);
  const [tag, setTag] = useState(DEFAULT_TAG);
  const [features, setFeatures] = useState<SavedFeature[] | null>(null);
  const [knownTags, setKnownTags] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    Promise.all([listSavedFeatures(), listSavedFeatureTags().catch(() => [])])
      .then(([f, t]) => {
        setFeatures(f);
        setKnownTags(t);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [open]);

  const matching = useMemo(() => {
    if (!features) return [];
    const wanted = tag.trim().toLowerCase();
    if (!wanted) return [];
    return features.filter((f) => tagsOf(f).some((t) => t.toLowerCase() === wanted));
  }, [features, tag]);

  const command = `npm run sites:publish -- --tags ${tag.trim() || DEFAULT_TAG}`;

  const copyCommand = useCallback(() => {
    navigator.clipboard.writeText(command).then(
      () => setToast('Command copied'),
      () => setToast('Could not copy — select it manually'),
    );
  }, [command]);

  // Kept as a fallback for when the repo checkout and the backend are not on
  // the same machine; the command path is the normal one.
  const downloadBundle = useCallback(() => {
    const url = apiUrl(`/saved-features/export?tags=${encodeURIComponent(tag.trim())}`);
    window.open(url, '_blank');
  }, [tag]);

  return (
    <>
      <Tooltip title="Publish showcase sites">
        <Fab
          size="small"
          color="primary"
          onClick={() => setOpen(true)}
          sx={{ position: 'absolute', bottom: 20, left: 20, zIndex: 1200 }}
        >
          <PublishIcon fontSize="small" />
        </Fab>
      </Tooltip>

      <Dialog open={open} onClose={() => setOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Publish showcase sites</DialogTitle>
        <DialogContent dividers>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Features carrying this tag become the pool for “Visit a random site” on the
            public map. Their saved figures are published with them.
          </Typography>

          <Autocomplete
            freeSolo
            options={knownTags}
            value={tag}
            onInputChange={(_, v) => setTag(v)}
            renderInput={(params) => <TextField {...params} label="Tag" size="small" autoFocus />}
          />

          {error && (
            <Typography variant="body2" color="error" sx={{ mt: 2 }}>
              Could not read saved features: {error}
            </Typography>
          )}

          <Box sx={{ mt: 2 }}>
            <Typography variant="subtitle2">
              {features === null ? 'Loading…' : `${matching.length} feature(s) match`}
            </Typography>

            {matching.length > 0 && (
              <List dense sx={{ maxHeight: 220, overflowY: 'auto' }}>
                {matching.map((f) => (
                  <ListItem key={f.id} disableGutters>
                    <ListItemText
                      primary={f.name || `Feature ${f.id}`}
                      secondary={f.geometry?.type}
                    />
                    {tagsOf(f).map((t) => (
                      <Chip key={t} label={t} size="small" sx={{ ml: 0.5 }} />
                    ))}
                  </ListItem>
                ))}
              </List>
            )}
          </Box>

          <Box sx={{ mt: 2 }}>
            <Typography variant="subtitle2" gutterBottom>
              Then run, in the frontend checkout:
            </Typography>
            <Box
              component="code"
              sx={{
                display: 'block',
                p: 1.2,
                borderRadius: 1,
                bgcolor: 'action.hover',
                fontSize: '0.78rem',
                overflowX: 'auto',
              }}
            >
              {command}
            </Box>
            <Typography variant="caption" color="text.secondary">
              Fetches the bundle from this backend, writes public/sites/, commits and pushes.
            </Typography>
          </Box>
        </DialogContent>

        <DialogActions>
          <Button onClick={downloadBundle} disabled={matching.length === 0}>
            Download bundle
          </Button>
          <Box sx={{ flex: 1 }} />
          <Button onClick={() => setOpen(false)}>Close</Button>
          <Button variant="contained" onClick={copyCommand} disabled={matching.length === 0}>
            Copy command
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={!!toast}
        autoHideDuration={2500}
        onClose={() => setToast(null)}
        message={toast ?? ''}
      />
    </>
  );
}
