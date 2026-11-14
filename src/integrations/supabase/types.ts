export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.17";
  };
  public: {
    Tables: {
      drivers: {
        Row: {
          active: boolean;
          code: string | null;
          full_name: string;
          id: string;
          number: number | null;
          team: string | null;
        };
        Insert: {
          active?: boolean;
          code?: string | null;
          full_name: string;
          id: string;
          number?: number | null;
          team?: string | null;
        };
        Update: {
          active?: boolean;
          code?: string | null;
          full_name?: string;
          id?: string;
          number?: number | null;
          team?: string | null;
        };
        Relationships: [];
      };
      jobs: {
        Row: {
          attempts: number;
          created_at: string;
          created_by: string | null;
          dedup_key: string | null;
          finished_at: string | null;
          id: string;
          last_error: string | null;
          max_attempts: number;
          payload: Json;
          result: Json | null;
          run_after: string;
          started_at: string | null;
          status: string;
          timeout_ms: number;
          type: string;
        };
        Insert: {
          attempts?: number;
          created_at?: string;
          created_by?: string | null;
          dedup_key?: string | null;
          finished_at?: string | null;
          id?: string;
          last_error?: string | null;
          max_attempts?: number;
          payload?: Json;
          result?: Json | null;
          run_after?: string;
          started_at?: string | null;
          status?: string;
          timeout_ms?: number;
          type: string;
        };
        Update: {
          attempts?: number;
          created_at?: string;
          created_by?: string | null;
          dedup_key?: string | null;
          finished_at?: string | null;
          id?: string;
          last_error?: string | null;
          max_attempts?: number;
          payload?: Json;
          result?: Json | null;
          run_after?: string;
          started_at?: string | null;
          status?: string;
          timeout_ms?: number;
          type?: string;
        };
        Relationships: [];
      };
      prediction_logs: {
        Row: {
          action: string;
          changes: Json;
          created_at: string;
          id: string;
          prediction_id: string;
          race_id: string;
          user_id: string;
        };
        Insert: {
          action: string;
          changes?: Json;
          created_at?: string;
          id?: string;
          prediction_id: string;
          race_id: string;
          user_id: string;
        };
        Update: {
          action?: string;
          changes?: Json;
          created_at?: string;
          id?: string;
          prediction_id?: string;
          race_id?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "prediction_logs_race_id_fkey";
            columns: ["race_id"];
            isOneToOne: false;
            referencedRelation: "races";
            referencedColumns: ["id"];
          },
        ];
      };
      predictions: {
        Row: {
          created_at: string;
          dnf_driver_id: string | null;
          fastest_lap_driver_id: string | null;
          id: string;
          pole_driver_id: string | null;
          race_id: string;
          top10: string[];
          updated_at: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          dnf_driver_id?: string | null;
          fastest_lap_driver_id?: string | null;
          id?: string;
          pole_driver_id?: string | null;
          race_id: string;
          top10?: string[];
          updated_at?: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          dnf_driver_id?: string | null;
          fastest_lap_driver_id?: string | null;
          id?: string;
          pole_driver_id?: string | null;
          race_id?: string;
          top10?: string[];
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "predictions_race_id_fkey";
            columns: ["race_id"];
            isOneToOne: false;
            referencedRelation: "races";
            referencedColumns: ["id"];
          },
        ];
      };
      profiles: {
        Row: {
          avatar_url: string | null;
          created_at: string;
          display_name: string;
          id: string;
          notify_telegram: boolean;
          telegram_chat_id: number | null;
          telegram_link_token: string | null;
          telegram_linked: boolean | null;
          telegram_linked_at: string | null;
          telegram_token_expires_at: string | null;
          telegram_username: string | null;
        };
        Insert: {
          avatar_url?: string | null;
          created_at?: string;
          display_name?: string;
          id: string;
          notify_telegram?: boolean;
          telegram_chat_id?: number | null;
          telegram_link_token?: string | null;
          telegram_linked?: boolean | null;
          telegram_linked_at?: string | null;
          telegram_token_expires_at?: string | null;
          telegram_username?: string | null;
        };
        Update: {
          avatar_url?: string | null;
          created_at?: string;
          display_name?: string;
          id?: string;
          notify_telegram?: boolean;
          telegram_chat_id?: number | null;
          telegram_link_token?: string | null;
          telegram_linked?: boolean | null;
          telegram_linked_at?: string | null;
          telegram_token_expires_at?: string | null;
          telegram_username?: string | null;
        };
        Relationships: [];
      };
      push_notifications_log: {
        Row: {
          id: string;
          race_id: string;
          sent_at: string;
          user_id: string;
          window_tag: string;
        };
        Insert: {
          id?: string;
          race_id: string;
          sent_at?: string;
          user_id: string;
          window_tag: string;
        };
        Update: {
          id?: string;
          race_id?: string;
          sent_at?: string;
          user_id?: string;
          window_tag?: string;
        };
        Relationships: [
          {
            foreignKeyName: "push_notifications_log_race_id_fkey";
            columns: ["race_id"];
            isOneToOne: false;
            referencedRelation: "races";
            referencedColumns: ["id"];
          },
        ];
      };
      push_subscriptions: {
        Row: {
          auth: string;
          endpoint: string;
          id: string;
          p256dh: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          auth: string;
          endpoint: string;
          id?: string;
          p256dh: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          auth?: string;
          endpoint?: string;
          id?: string;
          p256dh?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      race_debriefs: {
        Row: {
          content: string;
          created_at: string;
          model: string;
          race_id: string;
          updated_at: string;
        };
        Insert: {
          content: string;
          created_at?: string;
          model?: string;
          race_id: string;
          updated_at?: string;
        };
        Update: {
          content?: string;
          created_at?: string;
          model?: string;
          race_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "race_debriefs_race_id_fkey";
            columns: ["race_id"];
            isOneToOne: true;
            referencedRelation: "races";
            referencedColumns: ["id"];
          },
        ];
      };
      race_results: {
        Row: {
          driver_id: string;
          fastest_lap: boolean;
          finished: boolean;
          id: string;
          pole: boolean;
          position: number | null;
          race_id: string;
          status: string | null;
        };
        Insert: {
          driver_id: string;
          fastest_lap?: boolean;
          finished?: boolean;
          id?: string;
          pole?: boolean;
          position?: number | null;
          race_id: string;
          status?: string | null;
        };
        Update: {
          driver_id?: string;
          fastest_lap?: boolean;
          finished?: boolean;
          id?: string;
          pole?: boolean;
          position?: number | null;
          race_id?: string;
          status?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "race_results_race_id_fkey";
            columns: ["race_id"];
            isOneToOne: false;
            referencedRelation: "races";
            referencedColumns: ["id"];
          },
        ];
      };
      race_updates: {
        Row: {
          body: string | null;
          created_at: string;
          driver_id: string | null;
          id: string;
          race_id: string;
          title: string;
          type: string;
        };
        Insert: {
          body?: string | null;
          created_at?: string;
          driver_id?: string | null;
          id?: string;
          race_id: string;
          title: string;
          type: string;
        };
        Update: {
          body?: string | null;
          created_at?: string;
          driver_id?: string | null;
          id?: string;
          race_id?: string;
          title?: string;
          type?: string;
        };
        Relationships: [
          {
            foreignKeyName: "race_updates_driver_id_fkey";
            columns: ["driver_id"];
            isOneToOne: false;
            referencedRelation: "drivers";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "race_updates_race_id_fkey";
            columns: ["race_id"];
            isOneToOne: false;
            referencedRelation: "races";
            referencedColumns: ["id"];
          },
        ];
      };
      races: {
        Row: {
          circuit: string | null;
          country: string | null;
          has_results: boolean;
          has_sprint: boolean;
          id: string;
          locality: string | null;
          name: string;
          qualifying_at: string | null;
          race_at: string;
          round: number;
          season: number;
          sprint_at: string | null;
          sprint_qualifying_at: string | null;
        };
        Insert: {
          circuit?: string | null;
          country?: string | null;
          has_results?: boolean;
          has_sprint?: boolean;
          id?: string;
          locality?: string | null;
          name: string;
          qualifying_at?: string | null;
          race_at: string;
          round: number;
          season?: number;
          sprint_at?: string | null;
          sprint_qualifying_at?: string | null;
        };
        Update: {
          circuit?: string | null;
          country?: string | null;
          has_results?: boolean;
          has_sprint?: boolean;
          id?: string;
          locality?: string | null;
          name?: string;
          qualifying_at?: string | null;
          race_at?: string;
          round?: number;
          season?: number;
          sprint_at?: string | null;
          sprint_qualifying_at?: string | null;
        };
        Relationships: [];
      };
      reminder_deliveries: {
        Row: {
          id: string;
          race_id: string;
          sent_at: string;
          session_type: string;
          target_type: string;
          user_id: string | null;
          window_key: string;
        };
        Insert: {
          id?: string;
          race_id: string;
          sent_at?: string;
          session_type: string;
          target_type: string;
          user_id?: string | null;
          window_key: string;
        };
        Update: {
          id?: string;
          race_id?: string;
          sent_at?: string;
          session_type?: string;
          target_type?: string;
          user_id?: string | null;
          window_key?: string;
        };
        Relationships: [
          {
            foreignKeyName: "reminder_deliveries_race_id_fkey";
            columns: ["race_id"];
            isOneToOne: false;
            referencedRelation: "races";
            referencedColumns: ["id"];
          },
        ];
      };
      scores: {
        Row: {
          breakdown: Json;
          id: string;
          points: number;
          race_id: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          breakdown?: Json;
          id?: string;
          points?: number;
          race_id: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          breakdown?: Json;
          id?: string;
          points?: number;
          race_id?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "scores_race_id_fkey";
            columns: ["race_id"];
            isOneToOne: false;
            referencedRelation: "races";
            referencedColumns: ["id"];
          },
        ];
      };
      sprint_predictions: {
        Row: {
          created_at: string;
          id: string;
          pole_driver_id: string | null;
          race_id: string;
          top8: string[];
          updated_at: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          pole_driver_id?: string | null;
          race_id: string;
          top8?: string[];
          updated_at?: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          pole_driver_id?: string | null;
          race_id?: string;
          top8?: string[];
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "sprint_predictions_race_id_fkey";
            columns: ["race_id"];
            isOneToOne: false;
            referencedRelation: "races";
            referencedColumns: ["id"];
          },
        ];
      };
      sprint_results: {
        Row: {
          driver_id: string;
          finished: boolean;
          id: string;
          pole: boolean;
          position: number | null;
          race_id: string;
          status: string | null;
        };
        Insert: {
          driver_id: string;
          finished?: boolean;
          id?: string;
          pole?: boolean;
          position?: number | null;
          race_id: string;
          status?: string | null;
        };
        Update: {
          driver_id?: string;
          finished?: boolean;
          id?: string;
          pole?: boolean;
          position?: number | null;
          race_id?: string;
          status?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "sprint_results_race_id_fkey";
            columns: ["race_id"];
            isOneToOne: false;
            referencedRelation: "races";
            referencedColumns: ["id"];
          },
        ];
      };
      sync_state: {
        Row: {
          key: string;
          synced_at: string;
        };
        Insert: {
          key: string;
          synced_at?: string;
        };
        Update: {
          key?: string;
          synced_at?: string;
        };
        Relationships: [];
      };
      web_vitals: {
        Row: {
          conn: string;
          created_at: string;
          device: string;
          id: number;
          metric: string;
          route: string;
          value: number;
        };
        Insert: {
          conn: string;
          created_at?: string;
          device: string;
          id?: number;
          metric: string;
          route: string;
          value: number;
        };
        Update: {
          conn?: string;
          created_at?: string;
          device?: string;
          id?: number;
          metric?: string;
          route?: string;
          value?: number;
        };
        Relationships: [];
      };
      weekend_sessions: {
        Row: {
          classification: Json;
          id: string;
          race_id: string;
          session_type: string;
          starts_at: string | null;
          status: string;
          updated_at: string;
        };
        Insert: {
          classification?: Json;
          id?: string;
          race_id: string;
          session_type: string;
          starts_at?: string | null;
          status?: string;
          updated_at?: string;
        };
        Update: {
          classification?: Json;
          id?: string;
          race_id?: string;
          session_type?: string;
          starts_at?: string | null;
          status?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "weekend_sessions_race_id_fkey";
            columns: ["race_id"];
            isOneToOne: false;
            referencedRelation: "races";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      [_ in never]: never;
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    keyof DefaultSchema["Enums"] | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    keyof DefaultSchema["CompositeTypes"] | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  public: {
    Enums: {},
  },
} as const;
