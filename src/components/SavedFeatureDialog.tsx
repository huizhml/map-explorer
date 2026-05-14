import React from 'react';
import {
  Alert,
  Autocomplete,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  TextField,
  Typography,
} from '@mui/material';
import type { SavedFeatureGeometryType } from '../services/savedFeaturesApi';

export type SavedFeatureDialogPrefill = {
  name?: string;
  description?: string;
  category?: string;
  tags?: string[];
  /** Set when the prefill came from a previously-saved feature at the same
   *  geometry. Used to show a "filled from existing save" hint. */
  fromExistingId?: number | null;
};

type SavedFeatureDialogProps = {
  open: boolean;
  geometryType: SavedFeatureGeometryType | null;
  saving: boolean;
  error: string | null;
  existingCategories: string[];
  existingTags: string[];
  prefill?: SavedFeatureDialogPrefill | null;
  onCancel: () => void;
  onSubmit: (payload: {
    name: string;
    description: string;
    category: string;
    tags: string[];
  }) => void;
};

/** Case-insensitive dedupe preserving first-seen casing. Mirrors the backend
 *  normalizer so what the user sees on save matches what gets stored. */
function dedupeTags(tags: string[]): string[] {
  const seen = new Map<string, string>();
  for (const raw of tags) {
    const text = String(raw ?? '').trim();
    if (!text) continue;
    const key = text.toLocaleLowerCase();
    if (!seen.has(key)) seen.set(key, text);
  }
  return Array.from(seen.values());
}

export function SavedFeatureDialog({
  open,
  geometryType,
  saving,
  error,
  existingCategories,
  existingTags,
  prefill,
  onCancel,
  onSubmit,
}: SavedFeatureDialogProps) {
  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [category, setCategory] = React.useState('');
  const [tags, setTags] = React.useState<string[]>([]);

  // Reset on open; if a prefill is supplied (existing save at this geometry),
  // populate the fields from it so the user doesn't retype.
  React.useEffect(() => {
    if (!open) return;
    setName(prefill?.name ?? '');
    setDescription(prefill?.description ?? '');
    setCategory(prefill?.category ?? '');
    setTags(Array.isArray(prefill?.tags) ? dedupeTags(prefill!.tags!) : []);
  }, [open, prefill]);

  const handleSubmit = React.useCallback(() => {
    const trimmedName = name.trim();
    if (!trimmedName) return;
    onSubmit({
      name: trimmedName,
      description: description.trim(),
      category: category.trim(),
      tags: dedupeTags(tags),
    });
  }, [name, description, category, tags, onSubmit]);

  return (
    <Dialog open={open} onClose={saving ? undefined : onCancel} maxWidth="sm" fullWidth>
      <DialogTitle>Save feature to database</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: prefill?.fromExistingId ? 1 : 2 }}>
          Geometry type: {geometryType ?? 'Unknown'}
        </Typography>
        {prefill?.fromExistingId != null && (
          <Alert severity="info" sx={{ mb: 1.5, py: 0.25 }}>
            Prefilled from an earlier save of this same geometry — edit anything you want,
            saving will overwrite it.
          </Alert>
        )}
        <TextField
          autoFocus
          required
          fullWidth
          margin="dense"
          label="Name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <Autocomplete
          freeSolo
          fullWidth
          options={existingCategories}
          value={category}
          onInputChange={(_, value) => setCategory(value)}
          onChange={(_, value) => setCategory(typeof value === 'string' ? value : '')}
          renderInput={(params) => (
            <TextField
              {...params}
              margin="dense"
              label="Category"
              helperText={existingCategories.length > 0 ? 'Select an existing category or type a new one.' : 'Type a new category.'}
            />
          )}
        />
        <Autocomplete
          multiple
          freeSolo
          fullWidth
          options={existingTags}
          value={tags}
          onChange={(_, value) => setTags(dedupeTags(value as string[]))}
          // Hide already-selected tags from the suggestion list, case-insensitively.
          filterOptions={(options, state) => {
            const selectedKeys = new Set(tags.map((t) => t.toLocaleLowerCase()));
            const query = state.inputValue.trim().toLocaleLowerCase();
            return options.filter((opt) => {
              const key = opt.toLocaleLowerCase();
              if (selectedKeys.has(key)) return false;
              return !query || key.includes(query);
            });
          }}
          isOptionEqualToValue={(opt, val) => opt.toLocaleLowerCase() === String(val).toLocaleLowerCase()}
          renderInput={(params) => (
            <TextField
              {...params}
              margin="dense"
              label="Tags"
              placeholder={tags.length === 0 ? 'Add tags…' : ''}
              helperText={
                existingTags.length > 0
                  ? 'Type to filter existing tags, or press Enter to add a new one.'
                  : 'Press Enter to add a tag.'
              }
            />
          )}
        />
        <TextField
          fullWidth
          margin="dense"
          label="Description"
          multiline
          minRows={3}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
        {error ? (
          <Typography variant="caption" color="error" sx={{ mt: 1, display: 'block' }}>
            {error}
          </Typography>
        ) : null}
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel} disabled={saving}>Cancel</Button>
        <Button onClick={handleSubmit} variant="contained" disabled={saving || !name.trim()}>
          {saving ? 'Saving...' : 'Save'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
