import React from 'react';
import {
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

type SavedFeatureDialogProps = {
  open: boolean;
  geometryType: SavedFeatureGeometryType | null;
  saving: boolean;
  error: string | null;
  existingCategories: string[];
  onCancel: () => void;
  onSubmit: (payload: { name: string; description: string; category: string }) => void;
};

export function SavedFeatureDialog({
  open,
  geometryType,
  saving,
  error,
  existingCategories,
  onCancel,
  onSubmit,
}: SavedFeatureDialogProps) {
  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [category, setCategory] = React.useState('');

  React.useEffect(() => {
    if (!open) return;
    setName('');
    setDescription('');
    setCategory('');
  }, [open]);

  const handleSubmit = React.useCallback(() => {
    const trimmedName = name.trim();
    if (!trimmedName) return;
    onSubmit({
      name: trimmedName,
      description: description.trim(),
      category: category.trim(),
    });
  }, [name, description, category, onSubmit]);

  return (
    <Dialog open={open} onClose={saving ? undefined : onCancel} maxWidth="sm" fullWidth>
      <DialogTitle>Save feature to database</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Geometry type: {geometryType ?? 'Unknown'}
        </Typography>
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
