import { useState, useRef, useEffect, useCallback } from "react";
import { Input } from "@/components/ui/input";
import { Loader2, MapPin } from "lucide-react";
import { iconSize } from "@/design-system";
import { api, unwrapResult } from "@/lib/api/client";

interface AddressSuggestion {
  displayName: string;
  strasse: string;
  hausnummer: string;
  plz: string;
  stadt: string;
  latitude: number;
  longitude: number;
}

interface AddressAutocompleteProps {
  value: string;
  onChange: (value: string) => void;
  onAddressSelect: (address: { strasse: string; hausnummer: string; plz: string; stadt: string }) => void;
  placeholder?: string;
  id?: string;
  required?: boolean;
  "data-testid"?: string;
}

export function AddressAutocomplete({
  value,
  onChange,
  onAddressSelect,
  placeholder = "Straße eingeben...",
  id,
  required,
  "data-testid": testId,
}: AddressAutocompleteProps) {
  const [suggestions, setSuggestions] = useState<AddressSuggestion[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const suppressSearchRef = useRef(false);

  const search = useCallback(async (query: string) => {
    if (query.length < 3) {
      setSuggestions([]);
      setIsOpen(false);
      return;
    }

    setIsLoading(true);
    try {
      const result = await api.get<AddressSuggestion[]>(`/address-search?q=${encodeURIComponent(query)}`);
      const data = unwrapResult(result);
      setSuggestions(data);
      setIsOpen(data.length > 0);
      setActiveIndex(-1);
    } catch {
      setSuggestions([]);
      setIsOpen(false);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const handleInputChange = useCallback((newValue: string) => {
    onChange(newValue);

    if (suppressSearchRef.current) {
      suppressSearchRef.current = false;
      return;
    }

    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    debounceRef.current = setTimeout(() => {
      search(newValue);
    }, 500);
  }, [onChange, search]);

  const handleSelect = useCallback((suggestion: AddressSuggestion) => {
    suppressSearchRef.current = true;
    setIsOpen(false);
    setSuggestions([]);
    setActiveIndex(-1);
    onAddressSelect({
      strasse: suggestion.strasse,
      hausnummer: suggestion.hausnummer,
      plz: suggestion.plz,
      stadt: suggestion.stadt,
    });
  }, [onAddressSelect]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!isOpen || suggestions.length === 0) return;

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActiveIndex(prev => (prev < suggestions.length - 1 ? prev + 1 : 0));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActiveIndex(prev => (prev > 0 ? prev - 1 : suggestions.length - 1));
        break;
      case "Enter":
        e.preventDefault();
        if (activeIndex >= 0 && activeIndex < suggestions.length) {
          handleSelect(suggestions[activeIndex]);
        }
        break;
      case "Escape":
        setIsOpen(false);
        setActiveIndex(-1);
        break;
    }
  }, [isOpen, suggestions, activeIndex, handleSelect]);

  useEffect(() => {
    function handleClickOutside(e: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("pointerdown", handleClickOutside);
    return () => document.removeEventListener("pointerdown", handleClickOutside);
  }, []);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        <Input
          ref={inputRef}
          id={id}
          value={value}
          onChange={(e) => handleInputChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => { if (suggestions.length > 0) setIsOpen(true); }}
          placeholder={placeholder}
          required={required}
          data-testid={testId}
          autoComplete="off"
        />
        {isLoading && (
          <Loader2 className={`${iconSize.sm} absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-muted-foreground`} />
        )}
      </div>

      {isOpen && suggestions.length > 0 && (
        <div className="absolute z-50 mt-1 w-full rounded-md border bg-popover shadow-lg max-h-[240px] overflow-y-auto" data-testid="dropdown-address-suggestions">
          {suggestions.map((suggestion, index) => {
            const label = [suggestion.strasse, suggestion.hausnummer].filter(Boolean).join(" ");
            const sub = [suggestion.plz, suggestion.stadt].filter(Boolean).join(" ");
            return (
              <button
                key={index}
                type="button"
                className={`flex w-full items-start gap-2 px-3 py-2.5 text-left text-sm transition-colors ${
                  index === activeIndex ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"
                }`}
                onPointerDown={(e) => {
                  e.preventDefault();
                  handleSelect(suggestion);
                }}
                onPointerEnter={() => setActiveIndex(index)}
                data-testid={`suggestion-address-${index}`}
              >
                <MapPin className={`${iconSize.sm} mt-0.5 flex-shrink-0 text-muted-foreground`} />
                <div className="min-w-0">
                  <div className="font-medium truncate">{label}</div>
                  {sub && <div className="text-xs text-muted-foreground truncate">{sub}</div>}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
