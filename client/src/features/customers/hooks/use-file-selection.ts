import { useState, useCallback, useRef } from "react";

interface FilePreview {
  file: File;
  preview?: string;
}

export function useFileSelection() {
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [filePreviews, setFilePreviews] = useState<FilePreview[]>([]);
  const cameraInputRef = useRef<HTMLInputElement>(null);

  const addFiles = useCallback((newFiles: File[]) => {
    setSelectedFiles(prev => [...prev, ...newFiles]);
    const newPreviews = newFiles.map(file => ({
      file,
      preview: file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined,
    }));
    setFilePreviews(prev => [...prev, ...newPreviews]);
  }, []);

  const removeFile = useCallback((index: number) => {
    setFilePreviews(prev => {
      const removed = prev[index];
      if (removed?.preview) URL.revokeObjectURL(removed.preview);
      return prev.filter((_, i) => i !== index);
    });
    setSelectedFiles(prev => prev.filter((_, i) => i !== index));
  }, []);

  const clearAllFiles = useCallback(() => {
    setFilePreviews(prev => {
      prev.forEach(p => { if (p.preview) URL.revokeObjectURL(p.preview); });
      return [];
    });
    setSelectedFiles([]);
  }, []);

  const openCamera = useCallback(() => {
    cameraInputRef.current?.click();
  }, []);

  const onCameraFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length > 0) addFiles(files);
    e.target.value = "";
  }, [addFiles]);

  return {
    selectedFiles,
    filePreviews,
    cameraInputRef,
    addFiles,
    removeFile,
    clearAllFiles,
    openCamera,
    onCameraFileChange,
  };
}
